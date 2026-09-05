import { generateArbor, growToward, type ArborEdge, type ArborGraph, type ArborNode, type GrowthMode, type NodeRole, type Point } from "./arbor";

import { ArborSignals, type NodeSignalState } from "./arbor-signals";

const TAU = Math.PI * 2;
const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const freshSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

type Selection = { id: number; role: NodeRole } | null;
type Ripple = { point: Point; start: number };

/** The graph lives outside React; one canvas owns the animation and its lifecycle. */
export class ArborRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private onInteraction: () => void;
  private graph: ArborGraph;
  private births: number[] = [];
  private children: number[] = [];
  private signals: ArborSignals | null = null;
  private onInspect: (selection: Selection) => void;
  private inspected = -1;
  private lastTelemetry = -1;
  private ripples: Ripple[] = [];
  private observer: ResizeObserver;
  private motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  private reduced = this.motionQuery.matches;
  private paused = false;
  private light = false;
  private dirty = true;
  private width = 1;
  private height = 1;
  private scale = 1;
  private center: Point = { x: 0, y: 0 };
  private targetScale = 1;
  private targetCenter: Point = { x: 0, y: 0 };
  private pointer: Point | null = null;
  private hovered = -1;
  private time = 0;
  private previousTime = 0;
  private frame = 0;
  private lastTouch = -Infinity;
  private previousImage: HTMLCanvasElement | null = null;
  private transition = 0;

  constructor(canvas: HTMLCanvasElement, onInteraction: () => void, onInspect: (selection: Selection) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.onInteraction = onInteraction;
    this.onInspect = onInspect;
    this.graph = { nodes: [], edges: [], roots: [], seed: 0, mode: "canopy" };
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerleave", this.leave);
    canvas.addEventListener("click", this.click);
    canvas.addEventListener("keydown", this.keydown);
    this.motionQuery.addEventListener("change", this.motionChange);
    document.addEventListener("visibilitychange", this.visibilityChange);
    this.resize();
    this.frame = requestAnimationFrame(this.animate);
  }

  regenerate(mode: GrowthMode) {
    if (this.graph.nodes.length && !this.reduced) {
      this.previousImage = document.createElement("canvas");
      this.previousImage.width = this.canvas.width;
      this.previousImage.height = this.canvas.height;
      this.previousImage.getContext("2d")?.drawImage(this.canvas, 0, 0);
    }
    this.graph = generateArbor(freshSeed(), mode);
    this.fitScene(true);
    this.births = this.graph.nodes.map((node) => node.parent === null ? this.graph.roots.indexOf(node.id) * 0.45 : Infinity);
    for (const edge of this.graph.edges) {
      if (!edge.bridge) this.births[edge.to] = this.births[edge.from] + edge.length / 105 + 0.085 + (edge.to % 5) * 0.025;
    }
    this.time = this.reduced ? Math.max(...this.births) + 2 : 1.5;
    this.signals = new ArborSignals(this.graph, this.births);
    this.ripples = [];
    this.hovered = -1;
    this.inspect(-1);
    this.lastTelemetry = -1;
    this.lastTouch = -Infinity;
    this.transition = 0;
    this.paused = false;
    this.rebuildConnections();
    this.dirty = true;
    this.updateDescription();
  }

  setPaused(value: boolean) { this.paused = value; this.dirty = true; }
  setLight(value: boolean) { this.light = value; this.previousImage = null; this.dirty = true; }

  private updateDescription() {
    this.canvas.dataset.mode = this.graph.mode;
    this.canvas.dataset.nodes = String(this.graph.nodes.length);
    this.canvas.dataset.seed = String(this.graph.seed);
    this.canvas.dataset.roots = String(this.graph.roots.length);
    this.canvas.dataset.roles = JSON.stringify(this.graph.nodes.reduce<Record<string, number>>((counts, node) => { counts[node.role] = (counts[node.role] ?? 0) + 1; return counts; }, {}));
  }

  private rebuildConnections() {
    this.children = this.graph.nodes.map(() => 0);
    for (const edge of this.graph.edges) if (!edge.bridge) this.children[edge.from]++;
    this.signals?.sync(this.graph, this.births);
  }

  private inspect(id: number) {
    this.hovered = id;
    if (this.inspected === id) return;
    this.inspected = id;
    const node = this.graph.nodes[id];
    this.onInspect(node ? { id, role: node.role } : null);
    this.canvas.dataset.selected = node ? String(node.id) : "";
    this.canvas.dataset.selectedRole = node?.role ?? "";
  }

  private resize = () => {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.fitScene(true);
    this.previousImage = null;
    this.dirty = true;
  };

  private fitScene(immediate: boolean) {
    const nodes = this.graph.nodes;
    const minX = nodes.length ? Math.min(...nodes.map((node) => node.x)) : -380;
    const maxX = nodes.length ? Math.max(...nodes.map((node) => node.x)) : 380;
    const minY = nodes.length ? Math.min(...nodes.map((node) => node.y)) : -310;
    const maxY = 330;
    const top = this.height < 540 ? 48 : 90;
    const bottom = this.height < 540 ? 75 : 155;
    const room = this.height - top - bottom;
    this.targetScale = Math.max(0.15, Math.min((this.width - 40) / (maxX - minX + 80), room / (maxY - minY + 110)));
    this.targetCenter = {
      x: this.width / 2 - (minX + maxX) / 2 * this.targetScale,
      y: top + room / 2 - (minY + maxY) / 2 * this.targetScale,
    };
    if (immediate || this.reduced) {
      this.scale = this.targetScale;
      this.center = { ...this.targetCenter };
    }
  }

  private toWorld(event: MouseEvent | PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.center.x) / this.scale, y: (event.clientY - rect.top - this.center.y) / this.scale };
  }

  private nearest(point: Point, visibleOnly: boolean): number {
    let nearest = 0;
    let best = Infinity;
    for (const node of this.graph.nodes) {
      if (visibleOnly && this.births[node.id] > this.time) continue;
      const d = distance(point, node);
      if (d < best) { best = d; nearest = node.id; }
    }
    return nearest;
  }

  private move = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    this.pointer = this.toWorld(event);
    const id = this.nearest(this.pointer, true);
    this.inspect(distance(this.graph.nodes[id], this.pointer) < Math.max(18, 13 / this.scale) ? id : -1);
    this.dirty = true;
  };
  private leave = () => { this.pointer = null; this.inspect(-1); this.dirty = true; };
  private click = (event: MouseEvent) => { this.touch(this.toWorld(event)); };
  private keydown = (event: KeyboardEvent) => {
    if (event.repeat || !["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    if (event.key.startsWith("Arrow")) {
      const candidates = this.graph.nodes.filter((node) => node.role !== "relay" && this.births[node.id] <= this.time);
      if (!candidates.length) return;
      const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
      const index = candidates.findIndex((node) => node.id === this.hovered);
      const selected = candidates[(index + direction + candidates.length) % candidates.length];
      this.pointer = { x: selected.x, y: selected.y };
      this.inspect(selected.id);
      this.dirty = true;
      return;
    }
    if (event.key === "Enter") {
      const selected = this.graph.nodes[this.hovered >= 0 ? this.hovered : this.graph.roots[0]];
      if (selected) this.touch(selected);
    } else {
      const angle = (freshSeed() / 4294967296) * Math.PI;
      this.touch({ x: Math.cos(angle) * 340, y: 50 - Math.sin(angle) * 310 }, true);
    }
  };
  private motionChange = () => {
    this.reduced = this.motionQuery.matches;
    if (this.reduced) {
      this.time = Math.max(this.time, ...this.births) + 2;
      this.fitScene(true);
      this.ripples = [];
      this.previousImage = null;
    }
    this.dirty = true;
  };
  private visibilityChange = () => { this.previousTime = 0; this.dirty = true; };

  private touch(rawPoint: Point, forceGrowth = false) {
    if (!this.graph.nodes.length) return;
    // Bound growth to the exhibition area, including taps near the screen edges.
    const point = { x: clamp(rawPoint.x, -410, 410), y: clamp(rawPoint.y, -305, 260) };
    this.paused = false;
    this.onInteraction();
    const source = this.nearest(rawPoint, true);
    const hit = !forceGrowth && distance(rawPoint, this.graph.nodes[source]) < Math.max(18, 13 / this.scale);
    this.inspect(hit ? source : -1);
    const interactionTime = performance.now();
    if (!hit && (interactionTime - this.lastTouch > 200 || this.reduced)) {
      const added = growToward(this.graph, point, freshSeed());
      if (added.length) {
        // Wake the ancestor chain first; no new shoot can appear detached from its parent.
        const chain: number[] = [];
        let ancestor = this.graph.nodes[added[0]].parent;
        while (ancestor !== null && this.births[ancestor] > this.time) {
          chain.unshift(ancestor);
          ancestor = this.graph.nodes[ancestor].parent;
        }
        let arrival = this.time;
        for (const id of chain) {
          arrival += 0.1;
          this.births[id] = Math.min(this.births[id], arrival);
        }
        for (const id of added) {
          const node = this.graph.nodes[id];
          const parent = node.parent!;
          const edge = this.graph.edges.find((item) => !item.bridge && item.to === id)!;
          this.births[id] = this.reduced ? this.time : Math.max(this.time + 0.1, this.births[parent]) + edge.length / 130 + 0.13;
        }
        this.rebuildConnections();
        this.fitScene(false);
        this.updateDescription();
      }
      this.lastTouch = interactionTime;
    }
    this.signals?.step(this.time);
    this.signals?.inject(source, 1.3);
    if (!this.reduced) {
      this.ripples.push({ point: rawPoint, start: this.time });
      if (this.ripples.length > 8) this.ripples.shift();
    }
    this.dirty = true;
  }

  private ink(alpha: number) { return this.light ? `rgba(18,18,18,${clamp(alpha)})` : `rgba(235,235,235,${clamp(alpha)})`; }

  private polygon(x: number, y: number, radius: number, sides: number, angle = -Math.PI / 2) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i <= sides; i++) {
      const a = angle + i * TAU / sides;
      if (!i) ctx.moveTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
      else ctx.lineTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
    }
  }

  private circle(x: number, y: number, radius: number) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, Math.max(0.01, radius), 0, TAU);
  }

  private section(edge: ArborEdge, from: number, to: number) {
    const ctx = this.ctx;
    const begin = clamp(from) * edge.length;
    const end = clamp(to) * edge.length;
    let passed = 0;
    let started = false;
    ctx.beginPath();
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1];
      const b = edge.points[i];
      const length = distance(a, b);
      if (length < 0.001) continue;
      if (passed + length >= begin && passed <= end) {
        const lo = clamp((begin - passed) / length);
        const hi = clamp((end - passed) / length);
        if (!started) { ctx.moveTo(a.x + (b.x - a.x) * lo, a.y + (b.y - a.y) * lo); started = true; }
        ctx.lineTo(a.x + (b.x - a.x) * hi, a.y + (b.y - a.y) * hi);
      }
      passed += length;
      if (passed > end) break;
    }
    ctx.stroke();
  }

  private drawNode(node: ArborNode, state?: NodeSignalState) {
    const ctx = this.ctx;
    const age = this.time - this.births[node.id];
    if (age < 0) return;
    const energy = clamp(state?.energy ?? 0, 0, 2);
    const charge = clamp(state?.charge ?? 0);
    const growth = this.reduced ? 1 : 1 - Math.pow(1 - clamp(age / 0.65), 3);
    const special = node.role !== "relay";
    const radius = (node.role === "source" ? 10 : special ? Math.max(5.8, node.radius * 1.2, 2.5 / this.scale) : Math.max(2, 1 / this.scale)) * growth;
    const { x, y } = node;
    ctx.lineWidth = Math.max(0.8, 0.5 / this.scale);
    ctx.strokeStyle = this.ink((special ? 0.72 : 0.36) + energy * 0.25);
    ctx.fillStyle = this.light ? "#f4f4f4" : "#101010";
    const outline = (sides: number, angle?: number) => {
      this.polygon(x, y, radius, sides, angle);
      ctx.fill(); ctx.stroke();
    };
    switch (node.role) {
      case "source":
        outline(4);
        this.circle(x, y, radius * 0.5); ctx.stroke();
        break;
      case "amplifier":
        outline(3);
        ctx.beginPath();
        ctx.moveTo(x - radius * 0.45, y + radius * 0.06);
        ctx.lineTo(x, y - radius * 0.55);
        ctx.lineTo(x + radius * 0.45, y + radius * 0.06);
        ctx.stroke();
        if (energy > 0.2) {
          ctx.strokeStyle = this.ink(energy * 0.2);
          this.polygon(x, y, radius + energy * 4, 3); ctx.stroke();
        }
        break;
      case "collector":
        outline(6, 0);
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const angle = i * TAU / 3;
          ctx.moveTo(x + Math.cos(angle) * radius * 0.83, y + Math.sin(angle) * radius * 0.83);
          ctx.lineTo(x + Math.cos(angle) * radius * 0.25, y + Math.sin(angle) * radius * 0.25);
        }
        ctx.stroke();
        ctx.fillStyle = this.ink(0.25 + charge * 0.65);
        this.circle(x, y, radius * (0.15 + charge * 0.25)); ctx.fill();
        break;
      case "capacitor":
        this.circle(x, y, radius); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - radius * 0.25, y - radius * 0.53); ctx.lineTo(x - radius * 0.25, y + radius * 0.53);
        ctx.moveTo(x + radius * 0.25, y - radius * 0.53); ctx.lineTo(x + radius * 0.25, y + radius * 0.53);
        ctx.stroke();
        if (charge > 0) {
          ctx.strokeStyle = this.ink(0.9);
          ctx.lineWidth = Math.max(1.6, 0.9 / this.scale);
          ctx.beginPath(); ctx.arc(x, y, radius + 2.8, -Math.PI / 2, -Math.PI / 2 + charge * TAU); ctx.stroke();
          ctx.fillStyle = this.ink(charge * 0.5);
          ctx.fillRect(x - radius * 0.15, y + radius * 0.5 - radius * charge, radius * 0.3, radius * charge);
        }
        break;
      case "splitter":
        outline(4);
        ctx.beginPath();
        ctx.moveTo(x, y + radius * 0.6); ctx.lineTo(x, y);
        ctx.lineTo(x - radius * 0.52, y - radius * 0.26);
        ctx.moveTo(x, y); ctx.lineTo(x + radius * 0.52, y - radius * 0.26);
        ctx.stroke();
        break;
      case "gate": {
        outline(4, Math.PI / 4);
        const open = state?.phase === "open" || state?.phase === "release";
        ctx.beginPath();
        ctx.moveTo(x, y - radius * 0.65);
        ctx.lineTo(x + (open ? radius * 0.6 : 0), y + radius * 0.65);
        ctx.stroke();
        if (!open && charge > 0) {
          ctx.fillStyle = this.ink(0.7);
          ctx.fillRect(x - radius * 0.42, y - radius * 0.15, radius * 0.22, radius * 0.3);
        }
        break;
      }
      case "echo":
        this.circle(x, y, radius * 0.52); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, radius, -Math.PI * 0.8, Math.PI * 0.8); ctx.stroke();
        ctx.strokeStyle = this.ink(0.25 + energy * 0.2);
        ctx.beginPath(); ctx.arc(x, y, radius * 1.43, -Math.PI * 0.65, Math.PI * 0.65); ctx.stroke();
        break;
      default:
        outline(4, Math.PI / 4);
    }
    if (!["capacitor", "gate", "collector"].includes(node.role)) {
      ctx.fillStyle = this.ink(0.45 + energy * 0.3);
      const core = special ? 0.9 : 0.6;
      ctx.fillRect(x - core, y - core, core * 2, core * 2);
    }
    if (energy > 0.1) {
      ctx.strokeStyle = this.ink(clamp(energy) * 0.2);
      ctx.lineWidth = 0.65;
      this.circle(x, y, radius + 4 + (1 - clamp(energy)) * 10); ctx.stroke();
    }
    if (!this.reduced && age < 1.15) {
      const p = clamp(age / 1.15);
      ctx.strokeStyle = this.ink((1 - p) * 0.3);
      this.polygon(x, y, radius + p * 14, 4); ctx.stroke();
    }
  }

  private drawBackground() {
    const ctx = this.ctx;
    ctx.fillStyle = this.light ? "#f4f4f4" : "#080808";
    ctx.fillRect(0, 0, this.width, this.height);
    const glow = ctx.createRadialGradient(this.center.x, this.center.y - 70 * this.scale, 0, this.center.x, this.center.y, Math.max(this.width, this.height) * 0.55);
    glow.addColorStop(0, this.light ? "#eaeaea" : "#141414");
    glow.addColorStop(1, this.light ? "#f4f4f4" : "#080808");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);
    // A barely visible registration field gives the fine circuitry a sense of scale.
    ctx.fillStyle = this.ink(0.085);
    for (let x = this.center.x % 42; x < this.width; x += 42) {
      for (let y = this.center.y % 42; y < this.height; y += 42) ctx.fillRect(x, y, 0.65, 0.65);
    }
  }

  private drawRoots() {
    const ctx = this.ctx;
    for (const [index, id] of this.graph.roots.entries()) {
      const root = this.graph.nodes[id];
      if (this.time < this.births[id]) continue;
      const energy = clamp(this.signals?.nodeStates[id]?.energy ?? 0);
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = this.ink(0.08);
      ctx.beginPath(); ctx.moveTo(root.x - 55, root.y + 35); ctx.lineTo(root.x + 55, root.y + 35); ctx.stroke();
      ctx.strokeStyle = this.ink(0.2 + energy * 0.25);
      this.polygon(root.x, root.y, 19, 4); ctx.stroke();
      ctx.strokeStyle = this.ink(0.1 + energy * 0.12);
      this.circle(root.x, root.y, 27 + energy * 3); ctx.stroke();
      ctx.fillStyle = this.ink(0.4);
      ctx.font = "8px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(["I", "II", "III"][index] ?? String(index + 1), root.x, root.y + 49);
    }
  }

  private pointOnEdge(edge: ArborEdge, progress: number): Point {
    let travel = clamp(progress) * edge.length;
    for (let index = 1; index < edge.points.length; index++) {
      const from = edge.points[index - 1];
      const to = edge.points[index];
      const length = distance(from, to);
      if (travel <= length && length > 0) return { x: from.x + (to.x - from.x) * travel / length, y: from.y + (to.y - from.y) * travel / length };
      travel -= length;
    }
    return edge.points[edge.points.length - 1];
  }

  private drawPackets() {
    if (this.reduced) return;
    const ctx = this.ctx;
    for (const packet of this.signals?.packets ?? []) {
      const edge = this.graph.edges[packet.edge];
      if (!edge) continue;
      const progress = clamp((this.time - packet.start) / packet.duration);
      const reverse = packet.from !== edge.from;
      const head = reverse ? 1 - progress : progress;
      const tail = reverse ? Math.min(1, head + 0.18) : Math.max(0, head - 0.18);
      const energy = clamp(packet.energy, 0, 2);
      ctx.save();
      // Separate opposing traffic on grafts into two very fine lanes.
      if (edge.conduit) ctx.translate(reverse ? -1.7 : 1.7, 0);
      ctx.lineWidth = Math.max(0.85 / this.scale, 0.9 + energy * 0.9);
      ctx.strokeStyle = this.ink((packet.echo ? 0.38 : 0.5) + energy * 0.24);
      ctx.shadowColor = this.ink(0.55);
      ctx.shadowBlur = this.light ? 0 : 6 + energy * 3;
      this.section(edge, Math.min(tail, head), Math.max(tail, head));
      ctx.shadowBlur = 0;
      const point = this.pointOnEdge(edge, head);
      ctx.fillStyle = this.ink(0.95);
      if (packet.reply) {
        this.polygon(point.x, point.y, 2 + energy, 4); ctx.stroke();
      } else {
        this.circle(point.x, point.y, 1 + energy * 0.55); ctx.fill();
      }
      ctx.restore();
    }
  }

  private draw() {
    const ctx = this.ctx;
    const ratio = this.canvas.width / this.width;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawBackground();
    if (this.previousImage && this.transition < 1.2) {
      ctx.globalAlpha = (1 - this.transition / 1.2) * 0.45;
      ctx.drawImage(this.previousImage, 0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    } else this.previousImage = null;
    ctx.translate(this.center.x, this.center.y);
    ctx.scale(this.scale, this.scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const edge of this.graph.edges) {
      const fromBirth = this.births[edge.from];
      const toBirth = this.births[edge.to];
      const start = edge.bridge ? Math.max(fromBirth, toBirth) + 0.3 : fromBirth;
      const duration = edge.bridge ? 0.8 : Math.max(0.01, toBirth - fromBirth);
      const progress = this.reduced ? 1 : clamp((this.time - start) / duration);
      if (!progress) continue;
      const depth = this.graph.nodes[edge.to].depth;
      ctx.lineWidth = edge.bridge ? Math.max(0.65, 0.4 / this.scale) : Math.max(0.55 / this.scale, 1.65 - depth * 0.105);
      ctx.strokeStyle = this.ink(edge.bridge ? 0.2 : depth < 4 ? 0.65 : this.light ? 0.58 : 0.46);
      if (edge.bridge && !edge.conduit) ctx.setLineDash([2, 5]);
      if (edge.conduit) {
        ctx.strokeStyle = this.ink(0.35);
        ctx.lineWidth = Math.max(0.85, 0.5 / this.scale);
        this.section(edge, 0, progress * 0.5);
        this.section(edge, 1 - progress * 0.5, 1);
      } else this.section(edge, 0, progress);
      ctx.setLineDash([]);
      if (!edge.bridge && depth < 5) {
        ctx.save();
        ctx.translate(depth % 2 ? 3.4 : -3.4, 0);
        ctx.lineWidth = 0.65;
        ctx.strokeStyle = this.ink(0.18);
        this.section(edge, 0, progress);
        ctx.restore();
      }
      if (progress < 1 && !edge.bridge) {
        ctx.strokeStyle = this.ink(0.95);
        ctx.lineWidth = 1.55;
        ctx.shadowColor = this.ink(0.6);
        ctx.shadowBlur = this.light ? 0 : 8;
        this.section(edge, Math.max(0, progress - 0.07), progress);
        ctx.shadowBlur = 0;
      }
      if (edge.conduit) {
        const age = this.time - start - duration;
        if (age >= 0 && age < 1.8 && !this.reduced) {
          const center = this.pointOnEdge(edge, 0.5);
          const p = age / 1.8;
          ctx.lineWidth = 0.8;
          ctx.strokeStyle = this.ink((1 - p) * 0.7);
          this.polygon(center.x, center.y, 5 + p * 32, 4); ctx.stroke();
          ctx.strokeStyle = this.ink((1 - p) * 0.25);
          this.circle(center.x, center.y, 8 + p * 50); ctx.stroke();
        }
      }
    }
    this.drawPackets();
    for (const node of this.graph.nodes) this.drawNode(node, this.signals?.nodeStates[node.id]);
    this.drawRoots();
    for (const ripple of this.ripples) {
      const p = clamp((this.time - ripple.start) / 1.7);
      const eased = 1 - Math.pow(1 - p, 3);
      const { x, y } = ripple.point;
      ctx.strokeStyle = this.ink((1 - p) * 0.42);
      ctx.lineWidth = 0.75;
      this.circle(x, y, 8 + eased * 72); ctx.stroke();
      ctx.strokeStyle = this.ink((1 - p) * 0.17);
      this.circle(x, y, 5 + eased * 100); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const angle = i * TAU / 8;
        const r = 10 + eased * 38;
        ctx.fillStyle = this.ink((1 - p) * 0.75);
        this.polygon(x + Math.cos(angle) * r, y + Math.sin(angle) * r, (1 - p) * 2, 4); ctx.fill();
      }
    }
    if (this.hovered >= 0) {
      const node = this.graph.nodes[this.hovered];
      if (node) {
        ctx.strokeStyle = this.ink(0.32);
        ctx.lineWidth = 0.7;
        this.polygon(node.x, node.y, Math.max(node.radius, 5) + 6, 4); ctx.stroke();
        ctx.strokeStyle = this.ink(0.12);
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(this.pointer?.x ?? node.x, this.pointer?.y ?? node.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    const grown = String(this.births.filter((birth) => birth <= this.time).length);
    if (this.canvas.dataset.grown !== grown) this.canvas.dataset.grown = grown;
    if (this.time - this.lastTelemetry > 0.25 || this.reduced) {
      this.canvas.dataset.packets = String(this.signals?.packets.length ?? 0);
      this.canvas.dataset.activity = JSON.stringify(this.signals?.stats ?? {});
      this.canvas.dataset.connections = String(this.graph.edges.filter((edge) => edge.conduit && Math.max(this.births[edge.from], this.births[edge.to]) + 1.1 <= this.time).length);
      this.lastTelemetry = this.time;
    }
  }

  private animate = (now: number) => {
    const delta = this.previousTime ? Math.min((now - this.previousTime) / 1000, 0.05) : 0;
    this.previousTime = now;
    if (!document.hidden) {
      if (!this.paused && !this.reduced) {
        this.time += delta;
        this.transition += delta;
        const settle = 1 - Math.exp(-delta * 3);
        this.scale += (this.targetScale - this.scale) * settle;
        this.center.x += (this.targetCenter.x - this.center.x) * settle;
        this.center.y += (this.targetCenter.y - this.center.y) * settle;
        this.signals?.step(this.time);
        this.ripples = this.ripples.filter((ripple) => this.time - ripple.start < 1.7);
        this.dirty = true;
      }
      if (this.dirty) { this.draw(); this.dirty = false; }
    }
    this.frame = requestAnimationFrame(this.animate);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerleave", this.leave);
    this.canvas.removeEventListener("click", this.click);
    this.canvas.removeEventListener("keydown", this.keydown);
    this.motionQuery.removeEventListener("change", this.motionChange);
    document.removeEventListener("visibilitychange", this.visibilityChange);
    this.previousImage = null;
  }
}
