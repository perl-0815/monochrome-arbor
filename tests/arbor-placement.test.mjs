import assert from "node:assert/strict";
import test from "node:test";
import { NODE_ROLES, generateArbor, placeNode, planNodePlacement } from "../src/lib/arbor.ts";
import { ArborSignals } from "../src/lib/arbor-signals.ts";

function fixture() {
  const nodes = [
    { x: -60, y: 40, parent: null, origin: 0, depth: 0, role: "source" },
    { x: -30, y: 0, parent: 0, origin: 0, depth: 1, role: "relay" },
    { x: 70, y: 50, parent: null, origin: 2, depth: 0, role: "source" },
    { x: 40, y: 0, parent: 2, origin: 2, depth: 1, role: "relay" },
    { x: 10, y: -50, parent: 3, origin: 2, depth: 2, role: "relay" },
  ].map((node, id) => ({ id, kind: 0, radius: 4, ...node }));
  const edges = [[0, 1], [2, 3], [3, 4], [1, 3]].map(([from, to], id) => {
    const a = nodes[from];
    const b = nodes[to];
    const points = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }]
      .filter((point, index, all) => index === 0 || point.x !== all[index - 1].x || point.y !== all[index - 1].y);
    return { id, from, to, points, length: Math.abs(a.x - b.x) + Math.abs(a.y - b.y), bridge: id === 3, ...(id === 3 ? { conduit: true } : {}) };
  });
  return { nodes, edges, roots: [0, 2], seed: 42, mode: "canopy" };
}

function assertTrace(graph, edge, id) {
  assert.equal(edge.id, id);
  const from = graph.nodes[edge.from];
  const to = graph.nodes[edge.to];
  assert.deepEqual(edge.points[0], { x: from.x, y: from.y });
  assert.deepEqual(edge.points.at(-1), { x: to.x, y: to.y });
  let length = 0;
  for (let i = 1; i < edge.points.length; i++) {
    const dx = Math.abs(edge.points[i].x - edge.points[i - 1].x);
    const dy = Math.abs(edge.points[i].y - edge.points[i - 1].y);
    assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, "every trace stays octilinear");
    assert.ok(Math.hypot(dx, dy) > 0);
    length += Math.hypot(dx, dy);
  }
  assert.ok(Number.isFinite(edge.length) && edge.length > 0);
  assert.ok(Math.abs(length - edge.length) < 1e-7);
  if (from.origin !== to.origin) {
    assert.equal(edge.bridge, true);
    assert.equal(edge.conduit, true);
  }
}

for (const { role } of NODE_ROLES) {
  test(`placing ${role} appends exactly one chosen component and the previewed connections`, () => {
    const graph = fixture();
    const original = structuredClone(graph);
    const nodes = [...graph.nodes];
    const edges = [...graph.edges];
    const target = { x: 0, y: 0 };
    const plan = planNodePlacement(graph, target, role);
    assert.equal(plan.valid, true);
    assert.equal(plan.reason, null);
    assert.deepEqual(plan.point, target);
    assert.equal(plan.neighbors[0], 1, "the nearest node anchors the placement");
    assert.equal(plan.neighbors.length, role === "collector" || role === "splitter" ? 3 : 2);
    assert.ok(plan.neighbors.some((id) => graph.nodes[id].origin !== 0), "nearby colonies are joined");
    assert.deepEqual(graph, original, "planning is read-only");

    const result = placeNode(graph, target, role, 123);
    assert.deepEqual(result, { nodeId: original.nodes.length, reason: null });
    const node = graph.nodes[result.nodeId];
    assert.equal(graph.nodes.length, original.nodes.length + 1);
    assert.equal(node.role, role);
    assert.equal(node.manual, true);
    assert.equal(node.radius, 6.2);
    assert.equal(node.x, target.x);
    assert.equal(node.y, target.y);
    if (role === "source") {
      assert.equal(node.parent, null);
      assert.equal(node.depth, 0);
      assert.equal(node.origin, node.id);
      assert.deepEqual(graph.roots, [...original.roots, node.id]);
    } else {
      assert.equal(node.parent, plan.neighbors[0]);
      assert.equal(node.depth, graph.nodes[node.parent].depth + 1);
      assert.equal(node.origin, graph.nodes[node.parent].origin);
      assert.deepEqual(graph.roots, original.roots);
    }

    const appended = graph.edges.slice(original.edges.length);
    assert.deepEqual(appended.map((edge) => edge.from), plan.neighbors);
    assert.ok(appended.every((edge) => edge.to === node.id));
    assert.equal(appended.filter((edge) => !edge.bridge).length, role === "source" ? 0 : 1);
    graph.edges.forEach((edge, id) => assertTrace(graph, edge, id));
    assert.deepEqual(graph.nodes.slice(0, nodes.length), original.nodes);
    assert.deepEqual(graph.edges.slice(0, edges.length), original.edges);
    nodes.forEach((old, id) => assert.equal(graph.nodes[id], old, "existing node references survive"));
    edges.forEach((old, id) => assert.equal(graph.edges[id], old, "existing trace references survive"));
    assert.equal(graph.seed, original.seed);
    assert.equal(graph.mode, original.mode);

    const signals = new ArborSignals(graph, graph.nodes.map(() => -2));
    signals.inject(node.id);
    signals.step(8);
    assert.ok(signals.nodeStates[node.id].emitted > 0, "the manual component participates in real traffic");
  });
}

test("manual placements remain deterministic across growth modes and route seeds", () => {
  for (const mode of ["canopy", "spire", "rhizome"]) {
    const first = generateArbor(4317, mode);
    const second = structuredClone(first);
    const third = structuredClone(first);
    const target = { x: -414, y: -300 };
    const plan = planNodePlacement(first, target, "splitter");
    assert.ok(plan.valid);
    const firstEdge = first.edges.length;
    placeNode(first, target, "splitter", 123);
    placeNode(second, target, "splitter", 123);
    placeNode(third, target, "splitter", 987);
    assert.deepEqual(first, second, "the same placement seed recreates the same traces");
    assert.deepEqual(first.edges.slice(firstEdge).map(({ from, to }) => [from, to]), third.edges.slice(firstEdge).map(({ from, to }) => [from, to]));
    assert.notDeepEqual(first.edges.slice(firstEdge).map((edge) => edge.points), third.edges.slice(firstEdge).map((edge) => edge.points), "route elbows vary without moving the requested node or its neighbors");
    first.edges.slice(firstEdge).forEach((edge, index) => assertTrace(first, edge, firstEdge + index));
  }
});

test("manual sources join the live graph without resetting traffic and exchange replies", () => {
  const graph = fixture();
  const births = graph.nodes.map(() => -2);
  const signals = new ArborSignals(graph, births);
  signals.inject(0);
  const packets = structuredClone(signals.packets);
  const states = structuredClone(signals.nodeStates);
  const result = placeNode(graph, { x: 0, y: 0 }, "source", 42);
  births.push(0);
  signals.sync(graph, births);
  assert.deepEqual(signals.packets, packets);
  assert.deepEqual(signals.nodeStates.slice(0, states.length), states);
  const directions = new Set();
  let replied = false;
  for (let time = 0.05; time < 30; time += 0.05) {
    signals.step(time);
    for (const packet of signals.packets) {
      if (packet.from === result.nodeId) directions.add("out");
      if (packet.to === result.nodeId) {
        directions.add("in");
        replied ||= packet.reply;
      }
    }
  }
  assert.deepEqual(directions, new Set(["out", "in"]));
  assert.ok(replied, "a new source receives replies over its appended conduits");
  assert.ok(signals.nodeStates[result.nodeId].received > 0);
  assert.ok(signals.stats.exchanges > 0);
});

test("occupied, invalid, and out-of-bounds points are rejected atomically without repositioning", () => {
  const graph = fixture();
  const original = structuredClone(graph);
  const targets = [
    [{ x: -30, y: 0 }, "occupied"],
    [{ x: -18.01, y: 0 }, "occupied"],
    [{ x: -428.01, y: 0 }, "bounds"],
    [{ x: 428.01, y: 0 }, "bounds"],
    [{ x: 0, y: -316.01 }, "bounds"],
    [{ x: 0, y: 330.01 }, "bounds"],
    [{ x: NaN, y: 0 }, "bounds"],
    [{ x: Infinity, y: 0 }, "bounds"],
    [{ x: -Infinity, y: 0 }, "bounds"],
    [{ x: 0, y: NaN }, "bounds"],
    [{ x: 0, y: Infinity }, "bounds"],
  ];
  for (const [target, reason] of targets) {
    assert.deepEqual(planNodePlacement(graph, target, "relay"), { point: target, neighbors: [], valid: false, reason });
    assert.deepEqual(placeNode(graph, target, "relay", 42), { nodeId: null, reason });
    assert.deepEqual(graph, original);
  }
  assert.equal(planNodePlacement(graph, { x: -18, y: 0 }, "relay").valid, true, "exactly 12 world units is enough spacing");
});

test("all world-boundary points are accepted exactly", () => {
  for (const target of [{ x: -428, y: -316 }, { x: 428, y: -316 }, { x: -428, y: 330 }, { x: 428, y: 330 }]) {
    const graph = fixture();
    const result = placeNode(graph, target, "source", 41);
    assert.notEqual(result.nodeId, null);
    assert.equal(graph.nodes[result.nodeId].x, target.x);
    assert.equal(graph.nodes[result.nodeId].y, target.y);
    assert.ok(graph.edges.some((edge) => edge.to === result.nodeId), "a distant placement still attaches to its nearest anchor");
  }
});

test("stale previews are revalidated and the node cap cannot be exceeded", () => {
  const graph = fixture();
  const target = { x: 0, y: 0 };
  assert.equal(planNodePlacement(graph, target, "relay").valid, true);
  placeNode(graph, target, "capacitor", 42);
  const occupied = structuredClone(graph);
  assert.deepEqual(placeNode(graph, target, "relay", 43), { nodeId: null, reason: "occupied" });
  assert.deepEqual(graph, occupied);

  while (graph.nodes.length < 999) graph.nodes.push({ ...graph.nodes[0], id: graph.nodes.length });
  const lastPoint = { x: 120, y: -80 };
  assert.equal(planNodePlacement(graph, lastPoint, "relay").valid, true);
  assert.notEqual(placeNode(graph, lastPoint, "relay", 44).nodeId, null);
  assert.equal(graph.nodes.length, 1000);
  const full = structuredClone(graph);
  assert.deepEqual(planNodePlacement(graph, { x: 150, y: -80 }, "source"), { point: { x: 150, y: -80 }, neighbors: [], valid: false, reason: "limit" });
  assert.deepEqual(placeNode(graph, { x: 150, y: -80 }, "source", 45), { nodeId: null, reason: "limit" });
  assert.deepEqual(graph, full);
});

test("extra connections favor angular diversity and do not stretch across a sparse grove", () => {
  const graph = fixture();
  graph.nodes[0].x = -400;
  graph.nodes[0].y = 0;
  graph.nodes[1].x = -370;
  graph.nodes[1].y = 0;
  for (const node of graph.nodes.slice(2)) node.x = 400;
  const plan = planNodePlacement(graph, { x: -350, y: -50 }, "splitter");
  assert.ok(plan.valid);
  assert.deepEqual(new Set(plan.neighbors), new Set([0, 1]), "the third connection is omitted when only remote nodes remain");

  const local = fixture();
  const localPlan = planNodePlacement(local, { x: 0, y: 0 }, "splitter");
  assert.deepEqual(new Set(localPlan.neighbors), new Set([1, 3, 4]), "branches on three sides are preferred to a parallel redundant connection");
});

test("an empty grove accepts a first source and rejects components without an anchor", () => {
  const graph = { nodes: [], edges: [], roots: [], seed: 42, mode: "canopy" };
  assert.deepEqual(placeNode(graph, { x: 0, y: 0 }, "relay", 42), { nodeId: null, reason: "unconnected" });
  assert.equal(graph.nodes.length, 0);
  assert.deepEqual(placeNode(graph, { x: 0, y: 0 }, "source", 42), { nodeId: 0, reason: null });
  assert.deepEqual(graph.roots, [0]);
  assert.equal(graph.nodes[0].role, "source");
  assert.equal(graph.nodes[0].origin, 0);
  assert.equal(graph.nodes[0].parent, null);
});
