import assert from "node:assert/strict";
import test from "node:test";
import { ArborSignals } from "../src/lib/arbor-signals.ts";
import { generateArbor, placeNode, planNodePlacement } from "../src/lib/arbor.ts";

test("a manually placed relay waits for its birth and each connecting trace to finish growing", () => {
  const graph = {
    nodes: [-40, 40].map((x, id) => ({ id, x, y: 0, parent: null, origin: 0, depth: 0, kind: 0, radius: 4, role: "relay" })),
    edges: [], roots: [], seed: 42, mode: "canopy",
  };
  const births = [-2, -2];
  const signals = new ArborSignals(graph, births);
  const { nodeId } = placeNode(graph, { x: 0, y: 40 }, "relay", 42);
  births.push(2);
  signals.sync(graph, births);
  signals.inject(nodeId);
  signals.step(2.799);
  assert.equal(signals.nodeStates[nodeId].received, 0);
  assert.equal(signals.stats.sent, 0);

  signals.step(2.8);
  assert.equal(signals.nodeStates[nodeId].received, 1);
  assert.equal(signals.packets.length, 1);
  assert.equal(graph.edges[signals.packets[0].edge].bridge, false, "the parent trace is ready first");
  signals.step(3.099);
  signals.inject(nodeId);
  assert.ok(signals.packets.every((packet) => !graph.edges[packet.edge].bridge));

  signals.step(3.101);
  signals.inject(nodeId);
  signals.inject(nodeId);
  assert.ok(signals.packets.some((packet) => graph.edges[packet.edge].bridge), "the second connection carries traffic once its growth finishes");
  for (const packet of signals.packets) {
    assert.ok(packet.start >= 2.8);
    if (graph.edges[packet.edge].bridge) assert.ok(packet.start >= 3.1);
  }
});

test("source requests rotate fairly through reachable origins and include a source when its traces become ready", () => {
  const graph = { nodes: [], edges: [], roots: [], seed: 42, mode: "canopy" };
  for (let id = 0; id < 5; id++) assert.equal(placeNode(graph, { x: id * 40, y: 0 }, "source", id).nodeId, id);
  const signals = new ArborSignals(graph, [-2, -2, -2, -2, 20]);
  const seen = new Set();
  const earlyRequests = [];
  const laterDestinations = new Set();
  for (let frame = 0; frame <= 42 * 60; frame++) {
    const now = frame / 60;
    signals.step(now);
    for (const packet of signals.packets) {
      if (now < 21.1) assert.ok(packet.from !== 4 && packet.to !== 4, "an unborn source cannot carry requests or replies");
      if (seen.has(packet.id)) continue;
      seen.add(packet.id);
      if (packet.from !== 0 || packet.destination === null || packet.reply) continue;
      if (packet.start < 20) earlyRequests.push(packet.destination);
      else laterDestinations.add(packet.destination);
    }
  }
  assert.ok(earlyRequests.length >= 6);
  assert.deepEqual(earlyRequests, earlyRequests.map((_, index) => index % 3 + 1));
  assert.deepEqual(laterDestinations, new Set([1, 2, 3, 4]));
  assert.ok(signals.nodeStates[4].received > 0);
  assert.ok(signals.stats.exchanges > 0);
});

test("forty extra source placements sustain bounded traffic as their connections grow", () => {
  const graph = generateArbor(4317, "canopy");
  const births = graph.nodes.map(() => -2);
  const added = [];
  for (let y = 320; y >= -300 && added.length < 40; y -= 30) {
    for (let x = -415; x <= 415 && added.length < 40; x += 30) {
      const target = { x, y };
      if (!planNodePlacement(graph, target, "source").valid) continue;
      const { nodeId } = placeNode(graph, target, "source", 200 + added.length);
      births[nodeId] = added.length * 0.05;
      added.push(nodeId);
    }
  }
  assert.equal(added.length, 40);
  assert.ok(graph.nodes.length < 1000);
  const signals = new ArborSignals(graph, births);
  for (let frame = 0; frame <= 600; frame++) {
    signals.step(frame / 60);
    assert.ok(signals.packets.length <= 240);
    for (const packet of signals.packets) {
      const edge = graph.edges[packet.edge];
      const ready = Math.max(births[edge.from], births[edge.to]) + 0.8 + (edge.bridge ? 0.3 : 0);
      assert.ok(packet.start >= ready - 1e-8);
    }
  }
  assert.ok(added.every((id) => signals.nodeStates[id].emitted > 0));
  assert.ok(signals.stats.exchanges > 0);
  assert.equal(signals.nodeStates.length, graph.nodes.length);
  assert.ok(signals.nodeStates.every((state) => Number.isFinite(state.energy) && state.energy >= 0 && state.charge >= 0 && state.charge <= 1));
});
