import assert from "node:assert/strict";
import test from "node:test";
import { ArborSignals } from "../src/lib/arbor-signals.ts";
import { generateArbor, growToward } from "../src/lib/arbor.ts";

function fixture(roles, pairs, roots = []) {
  const nodes = roles.map((role, id) => ({ id, role, origin: roots.includes(id) ? id : roots[0] ?? 0, parent: null, x: id * 19, y: 0, depth: 0, kind: 0, radius: 4 }));
  const edges = pairs.map(([from, to, bridge = false], id) => ({ id, from, to, bridge, conduit: bridge, length: 19, points: [{ x: nodes[from].x, y: 0 }, { x: nodes[to].x, y: 0 }] }));
  return { nodes, edges, roots, seed: 42, mode: "canopy" };
}

function simulation(roles, pairs, roots) {
  const graph = fixture(roles, pairs, roots);
  return new ArborSignals(graph, graph.nodes.map(() => -2));
}

test("relay arrivals cause downstream traffic only after the upstream trace is traversed", () => {
  const signals = simulation(["relay", "relay", "relay"], [[0, 1], [1, 2]]);
  signals.inject(0, 1);
  assert.equal(signals.packets.length, 1);
  assert.equal(signals.packets[0].to, 1);
  assert.equal(signals.nodeStates[1].received, 0);
  const arrival = signals.packets[0].duration;
  signals.step(arrival - 0.001);
  assert.equal(signals.nodeStates[1].received, 0);
  signals.step(arrival);
  assert.equal(signals.nodeStates[1].received, 1);
  assert.equal(signals.packets.length, 1);
  assert.equal(signals.packets[0].from, 1);
  assert.equal(signals.packets[0].to, 2);
  assert.equal(signals.packets[0].start, arrival);
});

test("amplifiers increase actual transmitted energy and cap repeated strong input", () => {
  const signals = simulation(["relay", "amplifier", "relay"], [[0, 1], [1, 2]]);
  signals.inject(0, 0.5);
  const incoming = signals.packets[0].energy;
  signals.step(0.27);
  assert.equal(signals.stats.amplified, 1);
  assert.ok(signals.packets[0].energy > incoming * 1.5);
  signals.inject(1, 1000);
  assert.ok(signals.packets.every((packet) => packet.energy <= 2.8));
});

test("collectors merge converging inputs and flush a single orphan after a bounded window", () => {
  const signals = simulation(["relay", "relay", "collector", "relay"], [[0, 2], [1, 2], [2, 3]]);
  signals.inject(0, 0.4);
  signals.inject(1, 0.6);
  signals.step(0.27);
  assert.equal(signals.nodeStates[2].received, 2);
  assert.equal(signals.nodeStates[2].emitted, 0);
  assert.ok(signals.nodeStates[2].charge > 0.3);
  signals.step(0.45);
  assert.equal(signals.stats.collected, 1);
  assert.equal(signals.nodeStates[2].emitted, 1);
  assert.equal(signals.packets[0].to, 3, "aggregate continues outward instead of returning to either contributing input");
  assert.ok(signals.packets[0].energy > 0.9);

  const orphan = simulation(["collector", "relay"], [[0, 1]]);
  orphan.inject(0, 0.5);
  orphan.step(0.61);
  assert.equal(orphan.stats.sent, 0);
  orphan.step(0.63);
  assert.equal(orphan.stats.sent, 1);
  assert.equal(orphan.nodeStates[0].charge, 0);
});

test("capacitors retain input through minimum dwell, then release a combined burst or timeout", () => {
  const signals = simulation(["capacitor", "relay"], [[0, 1]]);
  signals.inject(0, 0.9);
  signals.step(0.2);
  signals.inject(0, 1);
  signals.step(0.69);
  assert.equal(signals.stats.sent, 0);
  assert.ok(signals.nodeStates[0].charge > 0.7);
  signals.step(0.71);
  assert.equal(signals.stats.released, 1);
  assert.equal(signals.packets.length, 1);
  assert.ok(signals.packets[0].energy > 1.8);
  assert.equal(signals.nodeStates[0].charge, 0);

  const weak = simulation(["capacitor", "relay"], [[0, 1]]);
  weak.inject(0, 0.2);
  weak.step(1.84);
  assert.equal(weak.stats.sent, 0);
  weak.step(1.86);
  assert.equal(weak.stats.released, 1);
});

test("splitters send separate packets to each route without creating energy", () => {
  const signals = simulation(["splitter", "relay", "relay", "relay"], [[0, 1], [0, 2], [0, 3]]);
  signals.inject(0, 1.2);
  assert.equal(signals.stats.split, 1);
  assert.equal(signals.packets.length, 3);
  assert.equal(new Set(signals.packets.map((packet) => packet.to)).size, 3);
  assert.ok(signals.packets.reduce((sum, packet) => sum + packet.energy, 0) <= 1.2);
});

test("gates buffer while closed and release only when their clock opens", () => {
  const signals = simulation(["gate", "relay"], [[0, 1]]);
  signals.step(2);
  signals.inject(0, 1);
  assert.equal(signals.stats.gated, 1);
  assert.equal(signals.stats.sent, 0);
  assert.ok(signals.nodeStates[0].charge > 0);
  signals.step(4.19);
  assert.equal(signals.stats.sent, 0);
  signals.step(4.21);
  assert.equal(signals.stats.sent, 1);
  assert.equal(signals.nodeStates[0].phase, "open");
});

test("echo nodes generate a delayed, weaker repeat without recursive repeats", () => {
  const signals = simulation(["echo", "echo", "relay"], [[0, 1], [1, 2]]);
  signals.inject(0, 1);
  const original = signals.packets[0].energy;
  signals.step(0.63);
  assert.equal(signals.stats.echoed, 2);
  signals.step(0.65);
  const repeat = signals.packets.find((packet) => packet.echo);
  assert.ok(repeat);
  assert.ok(repeat.energy < original * 0.5);
  signals.step(4);
  assert.equal(signals.stats.echoed, 2);
  assert.equal(signals.packets.length, 0);
});

test("terminal echo buds reflect a real packet back onto their incoming trace", () => {
  const signals = simulation(["relay", "echo"], [[0, 1]]);
  signals.inject(0, 1);
  signals.step(0.89);
  assert.equal(signals.packets.length, 0);
  signals.step(0.91);
  assert.equal(signals.packets.length, 1);
  assert.equal(signals.packets[0].from, 1);
  assert.equal(signals.packets[0].to, 0);
  assert.equal(signals.packets[0].echo, true);
  assert.ok(signals.packets[0].energy < 0.5);
  signals.step(2);
  assert.equal(signals.nodeStates[0].received, 2, "original click plus reflected return");
  assert.equal(signals.packets.length, 0);
});

test("source origins exchange requests and replies only after their connecting bridge has grown", () => {
  const graph = fixture(["source", "source"], [[0, 1, true]], [0, 1]);
  graph.nodes[1].origin = 1;
  const signals = new ArborSignals(graph, [0, 2]);
  signals.step(3.099);
  assert.equal(signals.stats.sent, 0, "bridge must wait for max birth + 0.3 + 0.8");
  const directions = new Set();
  let replySeen = false;
  for (let now = 3.1; now <= 12; now += 0.05) {
    signals.step(now);
    for (const packet of signals.packets) {
      assert.ok(packet.start >= 3.1 - 1e-8);
      directions.add(`${packet.from}:${packet.to}`);
      replySeen ||= packet.reply;
    }
  }
  assert.ok(directions.has("0:1") && directions.has("1:0"));
  assert.ok(replySeen);
  assert.ok(signals.stats.exchanges >= 2);
});

test("a request traverses every processing role and returns to its original source", () => {
  const roles = ["source", "amplifier", "collector", "capacitor", "splitter", "gate", "echo", "relay", "source", "relay"];
  const pairs = roles.slice(0, 8).map((_, id) => [id, id + 1, id === 4]);
  pairs.push([4, 9]);
  const signals = simulation(roles, pairs, [0, 8]);
  signals.step(70);
  assert.ok(signals.stats.exchanges > 0);
  for (const key of ["amplified", "collected", "released", "split", "gated", "echoed"]) assert.ok(signals.stats[key] > 0, `${key} runs on real traffic`);
  assert.ok(signals.nodeStates[0].received > 0 && signals.nodeStates[8].received > 0);
});

test("unborn nodes queue input and unborn traces never transmit", () => {
  const graph = fixture(["relay", "relay", "relay"], [[0, 1], [1, 2, true]]);
  const signals = new ArborSignals(graph, [0, 1, 2]);
  signals.inject(1, 1);
  signals.step(1.79);
  assert.equal(signals.nodeStates[1].received, 0);
  signals.step(1.8);
  assert.equal(signals.nodeStates[1].received, 1);
  assert.ok(signals.packets.every((packet) => packet.to !== 2));
  signals.step(3.09);
  signals.inject(1);
  assert.ok(signals.packets.every((packet) => packet.to !== 2));
  signals.step(3.11);
  signals.inject(1);
  assert.ok(signals.packets.some((packet) => packet.to === 2));
});

test("chronological processing gives the same traffic for frame-sized steps and larger jumps", () => {
  const graph = fixture(["source", "splitter", "capacitor", "collector", "gate", "echo", "source"], [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4, true], [4, 5], [5, 6, true]], [0, 6]);
  const births = graph.nodes.map((_, id) => id * 0.3);
  const smooth = new ArborSignals(graph, births);
  const jump = new ArborSignals(graph, births);
  for (let frame = 1; frame <= 3600; frame++) smooth.step(frame / 60);
  jump.step(60);
  assert.deepEqual(jump.stats, smooth.stats);
  assert.deepEqual(jump.packets, smooth.packets);
  for (const [id, state] of jump.nodeStates.entries()) {
    assert.equal(state.received, smooth.nodeStates[id].received);
    assert.equal(state.emitted, smooth.nodeStates[id].emitted);
    assert.ok(Math.abs(state.energy - smooth.nodeStates[id].energy) < 1e-8);
  }
});

test("sync preserves active packets and node state while appended growth becomes available", () => {
  const graph = fixture(["relay", "relay"], [[0, 1]]);
  const births = [-2, -2];
  const signals = new ArborSignals(graph, births);
  signals.inject(0);
  const packet = structuredClone(signals.packets[0]);
  const state = structuredClone(signals.nodeStates[0]);
  graph.nodes.push({ ...graph.nodes[1], id: 2, parent: 1, x: 38 });
  graph.edges.push({ id: 1, from: 1, to: 2, length: 19, bridge: false, points: [{ x: 19, y: 0 }, { x: 38, y: 0 }] });
  births.push(2);
  signals.sync(graph, births);
  assert.deepEqual(signals.packets[0], packet);
  assert.deepEqual(signals.nodeStates[0], state);
  signals.step(2.79);
  signals.inject(1);
  assert.ok(signals.packets.every((candidate) => candidate.to !== 2));
  signals.step(2.81);
  signals.inject(1);
  signals.inject(1);
  assert.ok(signals.packets.some((candidate) => candidate.to === 2));
});

test("cyclic traffic, invalid input, and very long clock jumps remain bounded and finite", () => {
  const roles = ["source", "splitter", "amplifier", "echo", "capacitor", "collector", "gate", "source"];
  const pairs = roles.flatMap((_, id) => [[id, (id + 1) % roles.length], [id, (id + 3) % roles.length, true]]);
  const signals = simulation(roles, pairs, [0, 7]);
  for (let second = 0; second <= 360; second++) {
    if (second % 5 === 0) for (let id = 0; id < roles.length; id++) signals.inject(id, 2.8);
    signals.step(second);
    assert.ok(signals.packets.length <= 240);
    assert.ok(signals.nodeStates.every((state) => Number.isFinite(state.energy) && state.energy >= 0 && state.charge >= 0 && state.charge <= 1));
  }
  const time = signals.now;
  for (const invalid of [NaN, Infinity, -Infinity, time - 1]) signals.step(invalid);
  assert.equal(signals.now, time);
  for (const invalid of [NaN, Infinity, -Infinity, -100]) signals.inject(0, invalid);
  signals.step(1_000_000);
  assert.equal(signals.now, 1_000_000);
  assert.ok(signals.packets.length <= 240);
  signals.step(1_000_003);
  assert.ok(signals.packets.length > 0, "sources resume after bounded catch-up");
});

test("generated colonies sustain processing and exchanges as interactive growth is appended", () => {
  for (const mode of ["canopy", "spire", "rhizome"]) {
    const graph = generateArbor(4317, mode);
    const births = graph.nodes.map((node) => node.depth * 0.3);
    const signals = new ArborSignals(graph, births);
    signals.step(70);
    const previous = signals.stats.delivered;
    const added = growToward(graph, { x: 90, y: -40 }, 921);
    for (const id of added) births[id] = 70 + (id - added[0]) * 0.12;
    signals.sync(graph, births);
    signals.inject(added[0]);
    signals.step(140);
    assert.ok(signals.stats.delivered > previous);
    assert.ok(signals.stats.exchanges > 0, `${mode} permits source request/reply`);
    assert.equal(signals.nodeStates.length, graph.nodes.length);
  }
});
