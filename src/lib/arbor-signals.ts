import type { ArborGraph } from "./arbor";

export interface NodeSignalState {
  energy: number;
  /** Stored input, normalized to a full reservoir. */
  charge: number;
  lastEvent: number;
  received: number;
  emitted: number;
  phase: "idle" | "holding" | "open" | "closed" | "release";
}

export interface SignalPacket {
  id: number;
  edge: number;
  from: number;
  to: number;
  start: number;
  duration: number;
  energy: number;
  echo: boolean;
  destination: number | null;
  reply: boolean;
}

interface Message {
  energy: number;
  from: number | null;
  hops: number;
  visited: number[];
  destination: number | null;
  request: number | null;
  reply: boolean;
  echo: boolean;
}

interface RuntimeNode {
  pending: Message[];
  release: number | null;
  heldSince: number;
  beats: number;
  cursor: number;
}

interface Event {
  id: number;
  time: number;
  kind: "arrival" | "source" | "release" | "forward" | "inject";
  node: number;
  message?: Message;
  packet?: number;
}

const MAX_PACKETS = 240;
const MAX_EVENTS = 1536;
const MAX_HELD = 12;
const MAX_HOPS = 96;
const MAX_ENERGY = 2.8;
const MIN_ENERGY = 0.012;
const EPSILON = 1e-8;
const GATE_PERIOD = 4.2;
const GATE_OPEN = 1.65;

function finiteEnergy(energy: number) {
  return Number.isFinite(energy) ? Math.max(0, Math.min(MAX_ENERGY, energy)) : 0;
}

/** A bounded event heap keeps packet arrivals independent of animation frame rate. */
class EventQueue {
  items: Event[] = [];

  push(event: Event) {
    if (this.items.length >= MAX_EVENTS) return false;
    let index = this.items.length;
    this.items.push(event);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(event, this.items[parent])) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = event;
    return true;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.before(this.items[child + 1], this.items[child])) child++;
        if (!this.before(this.items[child], last)) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }

  private before(a: Event, b: Event) {
    return a.time < b.time || (a.time === b.time && a.id < b.id);
  }
}

/**
 * Causal traffic on grown traces. Every visible packet has an arrival event;
 * node roles transform that arrival before any downstream packet is created.
 * Times are animation-clock seconds, so callers can pause by not calling step.
 */
export class ArborSignals {
  nodeStates: NodeSignalState[] = [];
  packets: SignalPacket[] = [];
  stats = {
    sent: 0,
    delivered: 0,
    amplified: 0,
    collected: 0,
    released: 0,
    split: 0,
    gated: 0,
    echoed: 0,
    /** Completed request/reply round trips between distinct growth origins. */
    exchanges: 0,
  };

  private graph: ArborGraph;
  private births: number[];
  private runtime: RuntimeNode[] = [];
  private events = new EventQueue();
  private adjacency: { edge: number; to: number }[][] = [];
  private ready: number[] = [];
  private active: boolean[] = [];
  private nextActivation = Infinity;
  private routes = new Map<number, number[]>();
  private sequence = 0;
  private packetSequence = 0;
  private time = 0;

  constructor(graph: ArborGraph, births: number[]) {
    this.graph = graph;
    this.births = births;
    this.sync(graph, births);
  }

  get now() {
    return this.time;
  }

  /** Append newly grown nodes and traces without restarting existing traffic. */
  sync(graph: ArborGraph, births: number[]) {
    this.graph = graph;
    this.births = [...births];
    const previousCount = this.nodeStates.length;
    for (let id = previousCount; id < graph.nodes.length; id++) {
      this.nodeStates.push({ energy: 0, charge: 0, lastEvent: -Infinity, received: 0, emitted: 0, phase: "idle" });
      this.runtime.push({ pending: [], release: null, heldSince: 0, beats: 0, cursor: id % 3 });
      if (graph.nodes[id].role === "source") {
        const start = Math.max(this.time + 0.12, this.nodeReady(id) + 0.15 + (graph.roots.indexOf(id) % 3) * 0.24);
        this.schedule("source", id, start);
      }
    }
    this.adjacency = graph.nodes.map(() => []);
    this.ready = graph.edges.map((edge, index) => {
      this.adjacency[edge.from].push({ edge: index, to: edge.to });
      this.adjacency[edge.to].push({ edge: index, to: edge.from });
      return Math.max(this.nodeReady(edge.from), this.nodeReady(edge.to)) + (edge.bridge ? 0.3 : 0);
    });
    this.active = graph.edges.map(() => false);
    this.nextActivation = -Infinity;
    this.routes.clear();
    this.activate(this.time);
  }

  inject(nodeId: number, energy = 1.2) {
    if (!this.graph.nodes[nodeId]) return;
    const amount = finiteEnergy(energy);
    if (amount < MIN_ENERGY) return;
    const time = Math.max(this.time, this.nodeReady(nodeId));
    const message = this.message(amount);
    if (time <= this.time) this.receive(nodeId, message);
    else this.schedule("inject", nodeId, time, message);
  }

  step(now: number) {
    if (!Number.isFinite(now) || now < this.time) return;
    let processed = 0;
    while (this.events.items[0]?.time <= now) {
      const event = this.events.pop();
      if (!event) break;
      this.advance(Math.max(this.time, event.time));
      if (event.kind === "arrival") {
        const packetIndex = this.packets.findIndex((packet) => packet.id === event.packet);
        if (packetIndex !== -1 && event.message) {
          this.packets.splice(packetIndex, 1);
          this.stats.delivered++;
          this.receive(event.node, event.message);
        }
      } else if (event.kind === "source") this.beat(event.node);
      else if (event.kind === "release") this.release(event.node, event.time);
      else if (event.message && event.kind === "forward") this.forward(event.node, event.message);
      else if (event.message) this.receive(event.node, event.message);

      // A suspended tab may resume days later. Bound catch-up work and restart
      // clocks at the requested time instead of replaying millions of beats.
      if (++processed >= 24000 && this.events.items[0]?.time <= now) {
        this.events.items = [];
        this.packets = [];
        for (const [id, state] of this.runtime.entries()) {
          state.pending = [];
          state.release = null;
          this.nodeStates[id].charge = 0;
          this.nodeStates[id].phase = "idle";
          if (this.graph.nodes[id].role === "source") this.schedule("source", id, now + 0.2 + (id % 3) * 0.2);
        }
        break;
      }
    }
    this.advance(now);
  }

  private advance(time: number) {
    const decay = Math.exp(-(time - this.time) * 2.6);
    for (const [id, state] of this.nodeStates.entries()) {
      state.energy *= decay;
      if (this.graph.nodes[id].role === "gate") state.phase = this.isOpen(id, time) ? "open" : "closed";
      else if (!this.runtime[id].pending.length && time - state.lastEvent > 0.48) state.phase = "idle";
    }
    this.time = time;
    this.activate(time);
  }

  private nodeReady(id: number) {
    return Number.isFinite(this.births[id]) ? this.births[id] + 0.8 : Infinity;
  }

  private activate(time: number) {
    if (time + EPSILON < this.nextActivation) return;
    this.nextActivation = Infinity;
    let changed = false;
    for (let index = 0; index < this.ready.length; index++) {
      if (this.ready[index] <= time + EPSILON) {
        if (!this.active[index]) changed = true;
        this.active[index] = true;
      } else this.nextActivation = Math.min(this.nextActivation, this.ready[index]);
    }
    if (changed) this.routes.clear();
  }

  private schedule(kind: Event["kind"], node: number, time: number, message?: Message, packet?: number) {
    if (!Number.isFinite(time)) return false;
    return this.events.push({ id: ++this.sequence, kind, node, time, message, packet });
  }

  private message(energy: number): Message {
    return { energy, from: null, hops: MAX_HOPS, visited: [], destination: null, request: null, reply: false, echo: false };
  }

  private touch(id: number, energy: number) {
    const state = this.nodeStates[id];
    state.energy = Math.min(2.8, state.energy + energy);
    state.lastEvent = this.time;
  }

  private beat(id: number) {
    const runtime = this.runtime[id];
    this.touch(id, 0.85);
    const local = this.message(1.1);
    const exits = this.exits(id, local);
    for (const exit of this.rotate(id, exits).slice(0, 2)) this.send(id, exit, { ...local, energy: 0.85 });

    // Inspect one reachable origin per beat. Newly placed sources can invalidate
    // routes frequently; eagerly mapping every origin would stall a growth frame.
    for (let checked = 0; checked < this.graph.roots.length; checked++) {
      const destination = this.graph.roots[runtime.beats++ % this.graph.roots.length];
      if (destination === id || !Number.isFinite(this.distances(destination)[id])) continue;
      this.forward(id, { ...this.message(1.3), destination, request: id });
      break;
    }
    this.schedule("source", id, this.time + 2.2 + (id % 5) * 0.11);
  }

  private receive(id: number, message: Message) {
    const state = this.nodeStates[id];
    state.received++;
    this.touch(id, message.energy);
    const role = this.graph.nodes[id].role;

    if (message.destination === id) {
      if (message.reply) this.stats.exchanges++;
      else if (message.request !== null && message.request !== id) {
        this.schedule("forward", id, this.time + 0.24, {
          ...this.message(Math.max(0.7, message.energy)),
          destination: message.request,
          request: id,
          reply: true,
        });
      }
      return;
    }
    if (message.energy < MIN_ENERGY || message.hops <= 0) return;
    if (role === "collector" || role === "capacitor") {
      this.hold(id, message);
      return;
    }
    if (role === "gate" && !this.isOpen(id, this.time)) {
      this.stats.gated++;
      this.hold(id, message);
      return;
    }
    if (role === "amplifier") {
      message = { ...message, energy: Math.min(MAX_ENERGY, message.energy * 1.65) };
      this.stats.amplified++;
      this.touch(id, message.energy * 0.35);
    }
    if (role === "echo" && !message.echo) {
      this.stats.echoed++;
      const reflects = message.from !== null && this.exits(id, message).length === 0;
      this.schedule("forward", id, this.time + 0.64, {
        ...message,
        energy: message.energy * 0.42,
        // Terminal echo nodes reflect back along the trace that woke them.
        // A fresh bounded route permits the return; echo=true prevents repeats.
        from: reflects ? null : message.from,
        visited: reflects ? [] : message.visited,
        echo: true,
        destination: null,
        request: null,
        reply: false,
        hops: Math.min(18, message.hops),
      });
    }
    this.forward(id, message);
  }

  private hold(id: number, message: Message) {
    const runtime = this.runtime[id];
    if (runtime.pending.length >= MAX_HELD) return;
    if (!runtime.pending.length) runtime.heldSince = this.time;
    runtime.pending.push(message);
    const total = runtime.pending.reduce((sum, input) => sum + input.energy, 0);
    const state = this.nodeStates[id];
    const role = this.graph.nodes[id].role;
    state.charge = Math.min(1, total / (role === "capacitor" ? 1.7 : 2.4));
    state.phase = "holding";
    let releaseAt = runtime.heldSince + 0.62;
    if (role === "capacitor") releaseAt = total >= 1.7 ? Math.max(this.time + 0.05, runtime.heldSince + 0.7) : runtime.heldSince + 1.85;
    if (role === "collector" && runtime.pending.length > 1) releaseAt = Math.max(this.time + 0.06, runtime.heldSince + 0.18);
    if (role === "gate") releaseAt = this.time + GATE_PERIOD - this.gatePhase(id, this.time) + EPSILON;
    if (runtime.release === null || releaseAt < runtime.release) {
      if (this.schedule("release", id, releaseAt)) runtime.release = releaseAt;
      else if (runtime.release === null) {
        // A saturated queue can drop an input but must never strand a reservoir.
        runtime.pending = [];
        state.charge = 0;
        state.phase = "idle";
      }
    }
  }

  private release(id: number, time: number) {
    const runtime = this.runtime[id];
    if (runtime.release === null || Math.abs(runtime.release - time) > EPSILON) return;
    runtime.release = null;
    const messages = runtime.pending;
    runtime.pending = [];
    const role = this.graph.nodes[id].role;
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      // Never collapse distinct request destinations or replies into one signal.
      const key = `${message.destination}:${message.request}:${message.reply}`;
      const group = groups.get(key) ?? [];
      group.push(message);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const base = group[0];
      const energy = Math.min(MAX_ENERGY, group.reduce((sum, input) => sum + input.energy, 0));
      if (role === "collector" && group.length > 1) this.stats.collected += group.length - 1;
      if (role === "capacitor") this.stats.released++;
      this.touch(id, energy);
      this.forward(id, {
        ...base,
        energy,
        hops: Math.min(...group.map((input) => input.hops)),
        visited: [...new Set(group.flatMap((input) => input.visited))],
      });
    }
    this.nodeStates[id].charge = 0;
    this.nodeStates[id].phase = "release";
  }

  private gatePhase(id: number, time: number) {
    return ((time + id * 0.31) % GATE_PERIOD + GATE_PERIOD) % GATE_PERIOD;
  }

  private isOpen(id: number, time: number) {
    return this.gatePhase(id, time) < GATE_OPEN;
  }

  private exits(id: number, message: Message) {
    return this.adjacency[id].filter((exit) => this.active[exit.edge] && exit.to !== message.from && !message.visited.includes(exit.to));
  }

  private rotate(id: number, exits: { edge: number; to: number }[]) {
    if (!exits.length) return exits;
    const offset = this.runtime[id].cursor++ % exits.length;
    return [...exits.slice(offset), ...exits.slice(0, offset)];
  }

  private forward(id: number, message: Message) {
    if (message.hops <= 0 || message.energy < MIN_ENERGY) return;
    const role = this.graph.nodes[id].role;
    let exits = this.exits(id, message);
    if (message.destination !== null) {
      const distances = this.distances(message.destination);
      exits = exits.filter((exit) => distances[exit.to] < distances[id]);
      exits.sort((a, b) => this.travel(a.edge) + distances[a.to] - this.travel(b.edge) - distances[b.to]);
      const selected = exits[0];
      if (!selected) return;
      if (role === "splitter") {
        const side = this.exits(id, message).find((exit) => exit.edge !== selected.edge);
        if (side) {
          this.stats.split++;
          this.send(id, side, { ...message, energy: message.energy * 0.16, destination: null, request: null, reply: false, hops: Math.min(16, message.hops) });
          this.send(id, selected, { ...message, energy: message.energy * 0.84 });
          return;
        }
      }
      this.send(id, selected, message);
    } else {
      exits = this.rotate(id, exits);
      const count = role === "splitter" ? Math.min(3, exits.length) : 1;
      if (count > 1) this.stats.split++;
      for (const exit of exits.slice(0, count)) this.send(id, exit, { ...message, energy: message.energy / count });
    }
  }

  private travel(edge: number) {
    return Math.max(0.18, Math.min(1.35, 0.16 + this.graph.edges[edge].length / 190));
  }

  private send(id: number, exit: { edge: number; to: number }, message: Message) {
    if (!this.active[exit.edge] || this.packets.length >= MAX_PACKETS || message.hops <= 0) return;
    const energy = finiteEnergy(message.energy * 0.975);
    if (energy < MIN_ENERGY) return;
    const packet: SignalPacket = {
      id: ++this.packetSequence,
      edge: exit.edge,
      from: id,
      to: exit.to,
      start: this.time,
      duration: this.travel(exit.edge),
      energy,
      echo: message.echo,
      destination: message.destination,
      reply: message.reply,
    };
    const next = { ...message, energy, from: id, hops: message.hops - 1, visited: [...message.visited, id] };
    if (this.schedule("arrival", exit.to, this.time + packet.duration, next, packet.id)) {
      this.packets.push(packet);
      this.stats.sent++;
      this.nodeStates[id].emitted++;
      this.touch(id, energy * 0.35);
    }
  }

  /** Cached shortest active-trace routes are used only to choose the next hop. */
  private distances(destination: number) {
    const cached = this.routes.get(destination);
    if (cached) return cached;
    const distances = this.graph.nodes.map(() => Infinity);
    const visited = this.graph.nodes.map(() => false);
    distances[destination] = 0;
    for (let count = 0; count < this.graph.nodes.length; count++) {
      let current = -1;
      let closest = Infinity;
      for (let id = 0; id < distances.length; id++) {
        if (!visited[id] && distances[id] < closest) {
          current = id;
          closest = distances[id];
        }
      }
      if (current === -1) break;
      visited[current] = true;
      for (const exit of this.adjacency[current]) {
        if (!this.active[exit.edge]) continue;
        const candidate = closest + this.travel(exit.edge);
        if (candidate < distances[exit.to]) distances[exit.to] = candidate;
      }
    }
    this.routes.set(destination, distances);
    return distances;
  }
}
