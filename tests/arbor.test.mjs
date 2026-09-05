import assert from "node:assert/strict";
import test from "node:test";
import { generateArbor, growToward, NODE_ROLES } from "../src/lib/arbor.ts";

const modes = ["canopy", "spire", "rhizome"];

function verifyGraph(graph) {
  assert.ok(graph.nodes.length > 0 && graph.nodes.length <= 1000);
  assert.equal(graph.roots.length, 3);
  assert.equal(new Set(graph.roots).size, 3);
  const normalDestinations = new Set();
  const neighbors = graph.nodes.map(() => []);
  const roles = new Set(NODE_ROLES.map((entry) => entry.role));

  for (const [id, node] of graph.nodes.entries()) {
    assert.equal(node.id, id);
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.ok(node.x >= -428 && node.x <= 428);
    assert.ok(node.y >= -316 && node.y <= 330);
    assert.ok(roles.has(node.role));
    assert.ok(graph.roots.includes(node.origin));
    if (graph.roots.includes(id)) {
      assert.equal(node.parent, null);
      assert.equal(node.depth, 0);
      assert.equal(node.origin, id);
      assert.equal(node.role, "source");
    } else {
      assert.ok(node.parent !== null && node.parent >= 0 && node.parent < id);
      assert.equal(node.depth, graph.nodes[node.parent].depth + 1);
      assert.equal(node.origin, graph.nodes[node.parent].origin, "a branch inherits its growth origin");
    }
  }

  for (const [id, edge] of graph.edges.entries()) {
    assert.equal(edge.id, id);
    const from = graph.nodes[edge.from];
    const to = graph.nodes[edge.to];
    assert.ok(from && to && edge.from !== edge.to);
    neighbors[edge.from].push(edge.to);
    neighbors[edge.to].push(edge.from);
    if (from.origin !== to.origin) {
      assert.equal(edge.bridge, true);
      assert.equal(edge.conduit, true);
    }
    assert.ok(edge.points.length >= 2);
    assert.deepEqual(edge.points[0], { x: from.x, y: from.y });
    assert.deepEqual(edge.points.at(-1), { x: to.x, y: to.y });

    let length = 0;
    for (let i = 1; i < edge.points.length; i++) {
      const dx = Math.abs(edge.points[i].x - edge.points[i - 1].x);
      const dy = Math.abs(edge.points[i].y - edge.points[i - 1].y);
      const segmentLength = Math.hypot(dx, dy);
      assert.ok(Number.isFinite(segmentLength) && segmentLength > 0);
      assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, "traces use 45° or 90° segments");
      length += segmentLength;
    }
    assert.ok(Math.abs(length - edge.length) < 1e-7);
    if (!edge.bridge) {
      assert.equal(to.parent, edge.from);
      assert.ok(!normalDestinations.has(edge.to), "each child has exactly one parent edge");
      normalDestinations.add(edge.to);
    }
  }

  assert.equal(normalDestinations.size, graph.nodes.length - graph.roots.length, "every branch is connected to its own origin");
  const reached = new Set([graph.roots[0]]);
  const frontier = [graph.roots[0]];
  for (let i = 0; i < frontier.length; i++) {
    for (const neighbor of neighbors[frontier[i]]) {
      if (!reached.has(neighbor)) {
        reached.add(neighbor);
        frontier.push(neighbor);
      }
    }
  }
  assert.equal(reached.size, graph.nodes.length, "conduits unite all growth origins into one communicating graph");
}

for (const mode of modes) {
  test(`${mode}: seeded variation preserves connected circuit geometry`, () => {
    const shapes = new Set();
    for (let sample = 0; sample < 24; sample++) {
      const seed = 4317 + sample * 997;
      const graph = generateArbor(seed, mode);
      assert.equal(graph.mode, mode);
      assert.equal(graph.seed, seed);
      assert.ok(graph.nodes.length >= 450 && graph.nodes.length <= 650);
      const conduits = graph.edges.filter((edge) => edge.conduit);
      assert.ok(conduits.length >= 3 && conduits.length <= 6);
      assert.ok(conduits.every((edge) => edge.length >= 35 && edge.length < 200), "colony seams have short, legible communication traces");
      assert.deepEqual(graph.roots.map((id) => ({ x: graph.nodes[id].x, y: graph.nodes[id].y })), [
        { x: -245, y: 260 }, { x: 0, y: 330 }, { x: 245, y: 245 },
      ]);
      for (const entry of NODE_ROLES) {
        assert.ok(graph.nodes.filter((node) => node.role === entry.role).length >= 3, `${entry.role} appears throughout the grove`);
        for (const origin of graph.roots) {
          assert.ok(graph.nodes.some((node) => node.origin === origin && node.role === entry.role), `${entry.role} appears in each colony`);
        }
      }
      assert.ok(graph.nodes.filter((node) => node.role === "relay").length >= graph.nodes.length * 0.45);
      verifyGraph(graph);
      assert.deepEqual(graph, generateArbor(seed, mode), "the same seed recreates the same tree");
      shapes.add(JSON.stringify(graph.nodes));
    }
    assert.equal(shapes.size, 24, "different seeds produce different structures");
  });
}

test("generation modes produce different structures for the same seed", () => {
  for (const seed of [0, 42, 4317, 0xffffffff]) {
    const structures = modes.map((mode) => JSON.stringify(generateArbor(seed, mode).nodes));
    assert.equal(new Set(structures).size, modes.length);
  }
});

test("clicks extend existing branches in dense areas and at the world boundaries", () => {
  const targets = [{ x: 0, y: 0 }, { x: -420, y: -310 }, { x: 420, y: 260 }];
  for (const mode of modes) {
    const graph = generateArbor(42, mode);
    for (const [index, target] of targets.entries()) {
      const originalNodes = structuredClone(graph.nodes);
      const originalEdges = structuredClone(graph.edges);
      const ids = growToward(graph, target, 921 + index);
      assert.ok(ids.length >= 8 && ids.length <= 20);
      assert.equal(graph.nodes.length, originalNodes.length + ids.length);
      assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => originalNodes.length + i));
      assert.deepEqual(graph.nodes.slice(0, originalNodes.length), originalNodes);
      assert.deepEqual(graph.edges.slice(0, originalEdges.length), originalEdges);
      assert.ok(graph.nodes[ids[0]].parent < originalNodes.length, "growth starts on the existing tree");
      verifyGraph(graph);
    }
  }
});

test("repeated growth reaches the node budget and then leaves the graph unchanged", () => {
  for (const mode of modes) {
    const graph = generateArbor(42, mode);
    for (let click = 0; click < 100 && graph.nodes.length < 1000; click++) {
      const previousCount = graph.nodes.length;
      const ids = growToward(graph, { x: Math.sin(click) * 400, y: Math.cos(click) * 250 }, click);
      assert.ok(ids.length <= 20);
      assert.equal(graph.nodes.length, previousCount + ids.length);
      assert.ok(graph.nodes.length <= 1000);
    }
    assert.equal(graph.nodes.length, 1000);
    verifyGraph(graph);
    const fullGraph = structuredClone(graph);
    assert.deepEqual(growToward(graph, { x: 0, y: -50 }, 1234), []);
    assert.deepEqual(graph, fullGraph);
  }
});

test("nonfinite pointer coordinates do not mutate the graph", () => {
  const graph = generateArbor(42, "rhizome");
  const original = structuredClone(graph);
  for (const target of [{ x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: -Infinity }, { x: 0, y: NaN }]) {
    assert.deepEqual(growToward(graph, target, 50), []);
    assert.deepEqual(graph, original);
  }
});
