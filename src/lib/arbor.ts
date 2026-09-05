export type GrowthMode = "canopy" | "spire" | "rhizome";

export type NodeRole = "source" | "relay" | "amplifier" | "collector" | "capacitor" | "splitter" | "gate" | "echo";

export const NODE_ROLES: { role: NodeRole; label: string; description: string }[] = [
  { role: "source", label: "発振", description: "異なるリズムで、森に信号を送り出す" },
  { role: "relay", label: "中継", description: "届いた信号を、隣の枝へ受け渡す" },
  { role: "amplifier", label: "増幅", description: "弱い信号を強め、遠くの枝まで届ける" },
  { role: "collector", label: "集約", description: "複数の信号をひとつに束ねて送り出す" },
  { role: "capacitor", label: "蓄積", description: "信号をしばらく溜め、満ちると解き放つ" },
  { role: "splitter", label: "分岐", description: "ひとつの信号を、複数の枝へ分ける" },
  { role: "gate", label: "開閉", description: "周期的に開き、信号の流れに間をつくる" },
  { role: "echo", label: "反響", description: "届いた信号を、少し遅れて響かせる" },
];

export const MODES: {
  id: GrowthMode;
  label: string;
  description: string;
}[] = [
  { id: "canopy", label: "Canopy", description: "分岐が重なり、広がる樹冠" },
  { id: "spire", label: "Spire", description: "幾層もの枝が、空へ積み重なる" },
  { id: "rhizome", label: "Rhizome", description: "見えない引力を探す、自由な枝" },
];

export interface Point {
  x: number;
  y: number;
}

export interface ArborNode extends Point {
  id: number;
  parent: number | null;
  depth: number;
  kind: number;
  radius: number;
  role: NodeRole;
  origin: number;
  readonly manual?: boolean;
}

export interface ArborEdge {
  id: number;
  from: number;
  to: number;
  points: Point[];
  length: number;
  bridge: boolean;
  conduit?: boolean;
}

export interface ArborGraph {
  nodes: ArborNode[];
  edges: ArborEdge[];
  seed: number;
  mode: GrowthMode;
  roots: number[];
}

export type NodePlacementReason = "occupied" | "limit" | "bounds" | "unconnected" | null;

export interface NodePlacementPlan {
  point: Point;
  /** The first neighbor is the parent, except for a new source. */
  neighbors: number[];
  valid: boolean;
  reason: NodePlacementReason;
}

export interface NodePlacementResult {
  nodeId: number | null;
  reason: NodePlacementReason;
}

type Random = () => number;
type Garden = { graph: ArborGraph; random: Random; budget?: number };

const MAX_NODES = 1000;
const TAU = Math.PI * 2;
const STEP_ANGLE = Math.PI / 4;

function seededRandom(seed: number): Random {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random: Random, min: number, max: number) {
  return min + random() * (max - min);
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function inside(point: Point, bottom = 270) {
  return point.x >= -428 && point.x <= 428 && point.y >= -316 && point.y <= bottom;
}

function clampPoint(point: Point): Point {
  return {
    x: Math.max(-420, Math.min(420, point.x)),
    y: Math.max(-310, Math.min(260, point.y)),
  };
}

/** Route through straight traces and 45° elbows, without zero-length segments. */
function circuitPath(from: Point, to: Point, random: Random): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const diagonal = Math.min(ax, ay);
  const extra = Math.abs(ax - ay);
  const lead = extra * between(random, 0.18, 0.7);
  const horizontal = ax > ay;
  const first = {
    x: from.x + (horizontal ? sx * lead : 0),
    y: from.y + (horizontal ? 0 : sy * lead),
  };
  const second = {
    x: first.x + sx * diagonal,
    y: first.y + sy * diagonal,
  };
  const points: Point[] = [{ x: from.x, y: from.y }];
  for (const point of [first, second, { x: to.x, y: to.y }]) {
    if (distance(points[points.length - 1], point) > 1e-9) points.push(point);
  }
  points[points.length - 1] = { x: to.x, y: to.y };
  return points;
}

function addEdge(garden: Garden, from: number, to: number, bridge = false) {
  const points = circuitPath(garden.graph.nodes[from], garden.graph.nodes[to], garden.random);
  const length = points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);
  garden.graph.edges.push({
    id: garden.graph.edges.length,
    from,
    to,
    points,
    length,
    bridge,
    ...(garden.graph.nodes[from].origin !== garden.graph.nodes[to].origin ? { conduit: true } : {}),
  });
}

function clearSpace(graph: ArborGraph, point: Point, spacing: number) {
  return !graph.nodes.some((node) => distance(node, point) < spacing);
}

/** Preview an exact placement and its local connections without changing the grove. */
export function planNodePlacement(graph: ArborGraph, target: Point, role: NodeRole): NodePlacementPlan {
  const point = { x: target.x, y: target.y };
  const reject = (reason: NodePlacementReason): NodePlacementPlan => ({ point, neighbors: [], valid: false, reason });
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !inside(point, 330)) return reject("bounds");
  if (graph.nodes.length >= MAX_NODES) return reject("limit");
  if (!clearSpace(graph, point, 12)) return reject("occupied");

  const candidates = graph.nodes
    .map((node) => ({ node, gap: distance(node, point), angle: Math.atan2(node.y - point.y, node.x - point.x) }))
    .sort((a, b) => a.gap - b.gap || a.node.id - b.node.id);
  if (!candidates.length) {
    return role === "source" ? { point, neighbors: [], valid: true, reason: null } : reject("unconnected");
  }

  const chosen = [candidates[0]];
  const count = role === "splitter" || role === "collector" ? 3 : 2;
  // The nearest trace always anchors the component. Additional traces stay local;
  // angular spread and other colonies make the connection legible and useful.
  const nearby = candidates.slice(1).filter((candidate) => candidate.gap <= 250);
  while (chosen.length < count && nearby.length) {
    const origins = new Set(chosen.map((candidate) => candidate.node.origin));
    const score = (candidate: typeof candidates[number]) => {
      const separation = Math.min(...chosen.map((neighbor) => Math.acos(Math.cos(candidate.angle - neighbor.angle))));
      return candidate.gap + (1 - separation / Math.PI) * 32 - (origins.has(candidate.node.origin) ? 0 : 20);
    };
    nearby.sort((a, b) => score(a) - score(b) || a.node.id - b.node.id);
    chosen.push(nearby.shift()!);
  }

  return { point, neighbors: chosen.map((candidate) => candidate.node.id), valid: true, reason: null };
}

/** Add one chosen component, preserving every existing node, trace, and origin. */
export function placeNode(graph: ArborGraph, target: Point, role: NodeRole, seed: number): NodePlacementResult {
  // Recompute at commit time: a preview may have become occupied or hit the limit.
  const plan = planNodePlacement(graph, target, role);
  if (!plan.valid) return { nodeId: null, reason: plan.reason };

  const id = graph.nodes.length;
  const parent = role === "source" ? null : plan.neighbors[0];
  const garden = { graph, random: seededRandom(seed ^ graph.seed ^ id) };
  graph.nodes.push({
    id,
    parent,
    ...plan.point,
    depth: parent === null ? 0 : graph.nodes[parent].depth + 1,
    kind: Math.floor(garden.random() * 6),
    radius: 6.2,
    role,
    origin: parent === null ? id : graph.nodes[parent].origin,
    manual: true,
  });
  if (parent === null) graph.roots.push(id);
  for (const neighbor of plan.neighbors) addEdge(garden, neighbor, id, neighbor !== parent);
  return { nodeId: id, reason: null };
}

function addNode(garden: Garden, parent: number | null, point: Point, spacing = 10): number | null {
  const { graph, random } = garden;
  if (graph.nodes.length >= (garden.budget ?? MAX_NODES) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (parent !== null && (!inside(point, 330) || !clearSpace(graph, point, spacing))) return null;
  const depth = parent === null ? 0 : graph.nodes[parent].depth + 1;
  const id = graph.nodes.length;
  graph.nodes.push({
    id,
    parent,
    x: point.x,
    y: point.y,
    depth,
    kind: Math.floor(random() * 6),
    radius: depth < 4 ? 5.6 - depth * 0.45 : between(random, 2.8, 5.3),
    role: parent === null ? "source" : "relay",
    origin: parent === null ? id : graph.nodes[parent].origin,
  });
  if (parent === null) graph.roots.push(id);
  if (parent !== null) addEdge(garden, parent, id);
  return id;
}

function makeStem(garden: Garden, height: number, steps: number): number[] {
  const stem = [addNode(garden, null, { x: 0, y: 330 })!];
  for (let i = 1; i <= steps; i++) {
    const x = i === 1 ? 0 : Math.round(between(garden.random, -5, 5));
    const id = addNode(garden, stem[stem.length - 1], {
      x,
      y: 330 - ((330 - height) * i) / steps,
    });
    if (id !== null) stem.push(id);
  }
  return stem;
}

/** A recursively divided crown: every fork owns its own shrinking pocket of sky. */
function canopy(garden: Garden) {
  const { graph, random } = garden;
  const stem = makeStem(garden, 146, 5);
  const fork = stem[stem.length - 1];
  const lift = [76, 65, 57, 49, 43];

  function branch(parent: number, center: number, width: number, level: number) {
    if (level === lift.length) return;
    const parentNode = graph.nodes[parent];
    const tilt = between(random, -9, 9);
    for (const side of [-1, 1]) {
      const point = {
        x: center + side * width * between(random, 0.22, 0.29) + tilt,
        y: Math.max(-309, parentNode.y - lift[level] + between(random, -16, 16)),
      };
      let id = addNode(garden, parent, point, 10.5);
      if (id === null) {
        point.y += between(random, 13, 22);
        id = addNode(garden, parent, point, 10.5);
      }
      if (id !== null) branch(id, point.x, width * 0.51, level + 1);
    }
  }

  const drift = between(random, -20, 20);
  for (let i = -1; i <= 1; i++) {
    const x = i * between(random, 214, 240) + drift;
    const y = i === 0 ? between(random, 14, 38) : between(random, 55, 82);
    const id = addNode(garden, fork, { x, y });
    if (id !== null) branch(id, x, between(random, 216, 254), 0);
  }

  // Short, asymmetrical low branches keep the trunk connected to the canopy.
  for (const side of [-1, 1]) {
    let parent = stem[3];
    for (let i = 0; i < 4; i++) {
      const point = { x: side * (42 + i * 27), y: 165 - i * between(random, 28, 35) };
      const id = addNode(garden, parent, point, 12);
      if (id !== null) {
        parent = id;
        if (i % 2 === 1) {
          const bud = addNode(garden, id, { x: point.x + side * 26, y: point.y - 5 }, 12);
          if (bud !== null) addNode(garden, bud, { x: point.x + side * 41, y: point.y - 29 }, 12);
        }
      }
    }
  }

  // Where nearby forks merged, reopen a few clear terminal buds at the crown's edge.
  const parents = new Set(graph.nodes.map((node) => node.parent));
  for (const tip of [...graph.nodes].reverse()) {
    if (graph.nodes.length >= 184) break;
    if (parents.has(tip.id) || tip.depth < 8) continue;
    const side = tip.x < 0 ? -1 : 1;
    for (const offset of [{ x: side * 19, y: -19 }, { x: 0, y: -24 }, { x: side * 25, y: 0 }]) {
      if (addNode(garden, tip.id, { x: tip.x + offset.x, y: tip.y + offset.y }, 11) !== null) break;
    }
  }
}

/** Apical growth with alternating tiers and upward-facing combs of smaller branches. */
function spire(garden: Garden) {
  const { graph, random } = garden;
  const stem = makeStem(garden, -306, 16);
  const handedness = random() < 0.5 ? -1 : 1;
  for (let tier = 0; tier < 7; tier++) {
    const origin = stem[3 + tier * 2];
    const base = graph.nodes[origin];
    const width = 302 - tier * 38;
    for (const side of [-1, 1]) {
      const segments = tier < 5 ? 7 : 5;
      const reach = width * between(random, 0.89, 1.07);
      let parent = origin;
      for (let j = 1; j <= segments; j++) {
        const point = {
          x: base.x + side * reach * (j / segments),
          y: base.y - j * between(random, 6, 9) + side * handedness * 6,
        };
        const id = addNode(garden, parent, point, 11);
        if (id === null) continue;
        parent = id;
        if (j % 2 === 0 || j === segments) {
          let twig = id;
          const count = tier > 4 ? 1 : 2;
          const lean = between(random, 5, 10);
          for (let k = 1; k <= count; k++) {
            const tip = {
              x: point.x + side * (lean * k + (j === segments ? k * 3 : 0)),
              y: point.y - k * between(random, 16, 21),
            };
            const next = addNode(garden, twig, tip, 10.5);
            if (next !== null) twig = next;
          }
        }
      }
    }
  }
}

/** Space colonization: branches negotiate with a seeded cloud of attraction points. */
function rhizome(garden: Garden) {
  const { graph, random } = garden;
  makeStem(garden, 168, 5);
  const attractors: Point[] = [];
  const lobes = [
    { x: -185, y: -60, rx: 183, ry: 201 },
    { x: 178, y: -88, rx: 184, ry: 204 },
    { x: -13, y: -177, rx: 158, ry: 134 },
    { x: 0, y: 40, rx: 198, ry: 111 },
  ];
  const wind = between(random, -0.09, 0.09);
  for (let i = 0; i < 610; i++) {
    const lobe = lobes[i % lobes.length];
    const angle = random() * TAU;
    const radius = Math.sqrt(random());
    const point = {
      x: lobe.x + Math.cos(angle) * radius * lobe.rx,
      y: lobe.y + Math.sin(angle) * radius * lobe.ry,
    };
    if (inside(point, 152)) attractors.push(point);
  }

  const children: number[] = graph.nodes.map(() => 1);
  children[children.length - 1] = 0;
  for (let iteration = 0; iteration < 105 && graph.nodes.length < 292 && attractors.length; iteration++) {
    const influence = new Map<number, { x: number; y: number; count: number }>();
    for (let a = attractors.length - 1; a >= 0; a--) {
      const attractor = attractors[a];
      let nearest = -1;
      let closest = 154;
      let consumed = false;
      for (let n = 5; n < graph.nodes.length; n++) {
        const gap = distance(attractor, graph.nodes[n]);
        if (gap < 22) {
          consumed = true;
          break;
        }
        if ((children[n] ?? 0) < 3 && gap < closest) {
          closest = gap;
          nearest = n;
        }
      }
      if (consumed) {
        attractors.splice(a, 1);
      } else if (nearest !== -1) {
        const force = influence.get(nearest) ?? { x: 0, y: 0, count: 0 };
        const node = graph.nodes[nearest];
        force.x += (attractor.x - node.x) / closest;
        force.y += (attractor.y - node.y) / closest;
        force.count++;
        influence.set(nearest, force);
      }
    }
    let growth = 0;
    for (const [parent, force] of influence) {
      if (graph.nodes.length >= 292) break;
      const node = graph.nodes[parent];
      const desired = Math.atan2(force.y / force.count - 0.12, force.x / force.count + wind);
      const angle = Math.round(desired / STEP_ANGLE) * STEP_ANGLE;
      const stride = between(random, 21, 28);
      for (const turn of [0, random() < 0.5 ? 1 : -1]) {
        const heading = angle + turn * STEP_ANGLE;
        const point = { x: node.x + Math.cos(heading) * stride, y: node.y + Math.sin(heading) * stride };
        if (!inside(point, 170)) continue;
        const id = addNode(garden, parent, point, 16.5);
        if (id !== null) {
          children[parent] = (children[parent] ?? 0) + 1;
          children[id] = 0;
          growth++;
          break;
        }
      }
    }
    if (!growth) break;
  }
}

function isAncestor(graph: ArborGraph, candidate: number, node: number): boolean {
  let cursor: number | null = node;
  while (cursor !== null) {
    if (cursor === candidate) return true;
    cursor = graph.nodes[cursor].parent;
  }
  return false;
}

function connectNeighbors(garden: Garden, count: number, candidates?: number[]) {
  const { graph, random } = garden;
  const used = new Set(graph.edges.filter((edge) => edge.bridge).flatMap((edge) => [edge.from, edge.to]));
  const ids = candidates ?? graph.nodes.map((node) => node.id);
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  let connected = 0;
  for (const id of shuffled) {
    const node = graph.nodes[id];
    if (node.depth < 6 || used.has(id)) continue;
    let neighbor: ArborNode | undefined;
    let closest = 62;
    for (const other of graph.nodes) {
      if (other.id === id || other.depth < 6 || used.has(other.id)) continue;
      if (other.parent === node.parent || Math.abs(other.depth - node.depth) > 4) continue;
      const gap = distance(node, other);
      if (gap < 27 || gap >= closest || Math.abs(node.y - other.y) > 44) continue;
      if (isAncestor(graph, id, other.id) || isAncestor(graph, other.id, id)) continue;
      neighbor = other;
      closest = gap;
    }
    if (!neighbor) continue;
    addEdge(garden, Math.min(id, neighbor.id), Math.max(id, neighbor.id), true);
    used.add(id);
    used.add(neighbor.id);
    if (++connected >= count) break;
  }
}

/** Each colony keeps its own growth grammar; shared traces negotiate the gaps between them. */
function connectColonies(garden: Garden) {
  const { graph } = garden;
  const endpoints = new Set<number>();
  for (let pair = 0; pair < graph.roots.length - 1; pair++) {
    const left = graph.nodes.filter((node) => node.origin === graph.roots[pair] && node.depth >= 4);
    const right = graph.nodes.filter((node) => node.origin === graph.roots[pair + 1] && node.depth >= 4);
    const midpoints: Point[] = [];
    for (let connection = 0; connection < 2; connection++) {
      let best: { from: number; to: number; score: number; midpoint: Point } | undefined;
      for (const from of left) {
        if (endpoints.has(from.id)) continue;
        for (const to of right) {
          if (endpoints.has(to.id)) continue;
          const gap = distance(from, to);
          if (gap < 35 || gap > 160) continue;
          const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
          if (midpoints.some((point) => distance(point, midpoint) < 86)) continue;
          // Prefer near-horizontal links across the open seams, away from the roots.
          const score = gap + Math.abs(from.y - to.y) * 0.55 + Math.max(0, midpoint.y - 80) * 0.4;
          if (!best || score < best.score) best = { from: from.id, to: to.id, score, midpoint };
        }
      }
      if (!best) continue;
      addEdge(garden, best.from, best.to, true);
      endpoints.add(best.from);
      endpoints.add(best.to);
      midpoints.push(best.midpoint);
    }
  }
}

/** Put components where their topology is useful, leaving most of the grove as quiet relays. */
function assignRoles(garden: Garden) {
  const { graph, random } = garden;
  const children = graph.nodes.map(() => 0);
  const degree = graph.nodes.map(() => 0);
  const conduits = new Set<number>();
  for (const node of graph.nodes) if (node.parent !== null) children[node.parent]++;
  for (const edge of graph.edges) {
    degree[edge.from]++;
    degree[edge.to]++;
    if (edge.conduit) {
      conduits.add(edge.from);
      conduits.add(edge.to);
    }
  }

  for (const root of graph.roots) {
    const colony = graph.nodes.filter((node) => node.origin === root && node.parent !== null);
    const jitter = new Map(colony.map((node) => [node.id, random() * 0.8]));
    const place = (role: NodeRole, count: number, score: (node: ArborNode) => number) => {
      const candidates = colony.filter((node) => node.role === "relay");
      candidates.sort((a, b) => (score(b) + jitter.get(b.id)!) - (score(a) + jitter.get(a.id)!));
      for (const node of candidates.slice(0, count)) node.role = role;
    };
    const scale = Math.max(1, Math.floor(colony.length / 30));
    place("collector", scale + 1, (node) => (conduits.has(node.id) ? 20 : 0) + degree[node.id] * 2);
    place("splitter", scale + 1, (node) => children[node.id] * 4 + Math.min(node.depth, 8) * 0.12);
    place("amplifier", scale, (node) => (children[node.id] ? 5 : 0) + 5 / (Math.abs(node.depth - 4) + 1));
    place("capacitor", scale, (node) => (degree[node.id] === 2 ? 5 : 0) + 3 / (Math.abs(node.depth - 7) + 1));
    place("gate", Math.max(1, scale - 1), (node) => (children[node.id] === 1 ? 4 : 0) + 3 / (Math.abs(node.depth - 10) + 1));
    place("echo", Math.max(1, scale - 1), (node) => (children[node.id] === 0 ? 6 : 0) + node.depth * 0.05);
  }
}

export function generateArbor(seed: number, mode: GrowthMode): ArborGraph {
  const graph: ArborGraph = { nodes: [], edges: [], roots: [], seed, mode };
  const garden = { graph, random: seededRandom(seed) };
  const positions = [
    { x: -245, y: 260, sx: 0.37, sy: 0.88 },
    { x: 0, y: 330, sx: 0.39, sy: 0.98 },
    { x: 245, y: 245, sx: 0.37, sy: 0.86 },
  ];

  for (const [index, position] of positions.entries()) {
    const colonySeed = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
    const colony: ArborGraph = { nodes: [], edges: [], roots: [], seed: colonySeed, mode };
    const nursery: Garden = { graph: colony, random: seededRandom(colonySeed), budget: mode === "rhizome" ? 200 : 210 };
    if (mode === "canopy") canopy(nursery);
    else if (mode === "spire") spire(nursery);
    else rhizome(nursery);
    connectNeighbors(nursery, Math.floor(colony.nodes.length / 32));

    const offset = graph.nodes.length;
    const mapping = new Map<number, number>();
    graph.roots.push(offset);
    for (const node of colony.nodes) {
      const point = {
        x: position.x + node.x * position.sx,
        y: position.y + (node.y - 330) * position.sy,
      };
      const parent = node.parent === null ? null : mapping.get(node.parent)!;
      // Leave a little air between neighboring colonies, even where their crowns overlap.
      if (parent !== null && graph.nodes.some((other) => other.origin !== offset && distance(other, point) < 8)) {
        mapping.set(node.id, parent);
        continue;
      }
      const id = graph.nodes.length;
      mapping.set(node.id, id);
      graph.nodes.push({
        ...node,
        id,
        parent,
        depth: parent === null ? 0 : graph.nodes[parent].depth + 1,
        origin: offset,
        ...point,
      });
    }
    // Re-route after the asymmetric transform so every elbow remains exactly 45°.
    for (const edge of colony.edges) {
      const from = mapping.get(edge.from)!;
      const to = mapping.get(edge.to)!;
      if (from !== to) addEdge(garden, from, to, edge.bridge);
    }
  }

  connectColonies(garden);
  assignRoles(garden);
  return graph;
}

/** Grow a small linked phrase of branches around the visitor's point of contact. */
export function growToward(graph: ArborGraph, target: Point, seed: number): number[] {
  if (graph.nodes.length >= MAX_NODES || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return [];
  const garden = { graph, random: seededRandom(seed ^ graph.seed ^ graph.nodes.length) };
  const { random } = garden;
  const destination = clampPoint(target);
  const children = new Map<number, number>();
  for (const node of graph.nodes) {
    if (node.parent !== null) children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
  }
  const origins = [...graph.nodes].sort((a, b) => {
    const score = (node: ArborNode) => distance(node, destination) + Math.max(0, (children.get(node.id) ?? 0) - 1) * 19;
    return score(a) - score(b);
  });
  const added: number[] = [];
  const limit = Math.min(12 + Math.floor(random() * 7), MAX_NODES - graph.nodes.length);

  function shoot(parent: number, desired: number, stride: number): number | null {
    const start = graph.nodes[parent];
    const angle = Math.round(desired / STEP_ANGLE) * STEP_ANGLE;
    const handedness = random() < 0.5 ? -1 : 1;
    for (const offset of [0, handedness, -handedness, 2 * handedness, -2 * handedness, 3 * handedness, -3 * handedness, 4]) {
      const direction = angle + offset * STEP_ANGLE;
      const point = { x: start.x + Math.cos(direction) * stride, y: start.y + Math.sin(direction) * stride };
      if (!inside(point)) continue;
      const id = addNode(garden, parent, point, 12.5);
      if (id !== null) {
        added.push(id);
        return id;
      }
    }
    return null;
  }

  let current = origins[0]?.id;
  if (current === undefined) return [];
  let heading = Math.atan2(destination.y - graph.nodes[current].y, destination.x - graph.nodes[current].x);
  if (distance(destination, graph.nodes[current]) < 25) heading = between(random, -Math.PI * 0.9, -Math.PI * 0.1);

  for (let i = 0; i < limit; i++) {
    const node = graph.nodes[current];
    const gap = distance(node, destination);
    const desired = gap > 36 && i < 5 ? Math.atan2(destination.y - node.y, destination.x - node.x) : heading;
    const next = shoot(current, desired, between(random, 21, 32));
    if (next !== null) {
      current = next;
      if (i % 3 === 2 && added.length > 2) {
        current = added[Math.max(0, added.length - 3)];
        heading += (random() < 0.5 ? -1 : 1) * STEP_ANGLE;
      }
    } else {
      current = origins[Math.min(i + 1, origins.length - 1)].id;
      heading = between(random, -Math.PI, 0);
    }
  }

  // An occupied click still finds nearby openings, without growing an unbounded graph.
  for (let attempt = 0; added.length < Math.min(8, limit) && attempt < 32; attempt++) {
    const parent = origins[attempt % Math.min(origins.length, 12)].id;
    shoot(parent, between(random, -Math.PI, Math.PI), between(random, 24, 38));
  }
  if (added.length) {
    connectNeighbors(garden, 2, added);
    const children = new Set(graph.nodes.map((node) => node.parent));
    for (const id of added) {
      const node = graph.nodes[id];
      const chance = random();
      if (chance < 0.07) node.role = "amplifier";
      else if (chance < 0.14) node.role = "capacitor";
      else if (chance < 0.20) node.role = "gate";
      else if (chance < 0.27) node.role = children.has(id) ? "splitter" : "echo";
      else if (chance < 0.33) node.role = "collector";
    }
  }
  return added;
}
