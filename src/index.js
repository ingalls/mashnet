const RTree = require("rbush");
const turf = require("@turf/turf");
const cover = require("@mapbox/tile-cover");
const tilebelt = require("@mapbox/tilebelt");
const softmax = require("softmax-fn");
const brain = require("brain.js");
const debug = require("./debug");

// set constants
const UNITS = { units: "kilometers" };
const DEG2RAD = Math.PI / 180.0;
const RAD2DEG = 180.0 / Math.PI;
const MAX_NODE_SHIFT = 0.01;
const MAX_VERTEX_SHIFT = 0.03;
const DEBUG_COLOR_1 = "#ff66ff"; // pink
const DEBUG_COLOR_2 = "#00ff00"; // green
const DEBUG_COLOR_3 = "#66ffff"; // cyan
const DEBUG_COLOR_4 = "#ff9900"; // orange

// constructor
const Mashnet = function(ways) {
  this.edges = new Map();
  this.vertices = new Map();
  this.nodes = new Map();
  this.metadata = new Map();
  this.nodetree = new RTree();
  this.edgetree = new RTree();
  this.id = 0;
  this.nn = new brain.NeuralNetwork();

  // load pretrained match model, if present
  var matchModel;
  try {
    matchModel = require("../model/match.json");
    this.nn.fromJSON(matchModel);
  } catch (e) {}

  for (let way of ways) {
    if (way.geometry.coordinates.length === way.properties.refs.length) {
      // setup vertices
      var i = 0;
      for (let ref of way.properties.refs) {
        this.vertices.set(ref, way.geometry.coordinates[i]);
        i++;
      }

      // setup nodes
      //   start
      var start = way.properties.refs[0];
      var adjacent = this.nodes.get(start);
      if (!adjacent) {
        adjacent = new Set();
      }
      adjacent.add(way.properties.id);
      this.nodes.set(start, adjacent);

      //   end
      var end = way.properties.refs[way.properties.refs.length - 1];
      var adjacent = this.nodes.get(end);
      if (!adjacent) {
        adjacent = new Set();
      }
      adjacent.add(way.properties.id);
      this.nodes.set(end, adjacent);

      // setup edges
      this.edges.set(way.properties.id, way.properties.refs);

      // setup metadata
      var metadata = {};
      for (let property of Object.keys(way.properties)) {
        if (["id", "refs"].indexOf(property) === -1) {
          metadata[property] = way.properties[property];
        }
      }
      this.metadata.set(way.properties.id, metadata);
    }
  }

  // setup nodetree
  var nodeItems = [];
  for (let node of this.nodes) {
    var vertex = this.vertices.get(node[0]);
    const item = {
      minX: vertex[0],
      minY: vertex[1],
      maxX: vertex[0],
      maxY: vertex[1],
      id: node[0]
    };
    nodeItems.push(item);
  }
  this.nodetree.load(nodeItems);
  nodeItems = null;

  // setup edgetree
  var edgeItems = [];
  for (let edge of this.edges) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (let ref of edge[1]) {
      var vertex = this.vertices.get(ref);
      if (vertex[0] < minX) minX = vertex[0];
      if (vertex[1] < minY) minY = vertex[1];
      if (vertex[0] > maxX) maxX = vertex[0];
      if (vertex[1] > maxY) maxY = vertex[1];
    }
    const item = {
      minX: minX,
      minY: minY,
      maxX: maxX,
      maxY: maxY,
      id: edge[0]
    };
    edgeItems.push(item);
  }
  this.edgetree.load(edgeItems);
  edgeItems = null;
};

Mashnet.prototype.scan = function(addition) {
  if (process.env.DEBUG) {
    debug({
      type: "log",
      message: "SCAN"
    });
    debug({
      type: "fit",
      bbox: turf.bbox(addition)
    });
    debug({
      type: "draw",
      geometry: addition.geometry,
      style: {
        width: 4,
        color: DEBUG_COLOR_1,
        opacity: 0.7
      },
      fade: 100000
    });
  }

  // find matching edge candidates

  // get candidates
  var buffer = 0.03;
  var bbox = turf.bbox(addition);
  var sw = turf.destination(turf.point(bbox.slice(0, 2)), buffer, 225, UNITS);
  var ne = turf.destination(turf.point(bbox.slice(2, 4)), buffer, 45, UNITS);

  var candidates = this.edgetree.search({
    minX: sw.geometry.coordinates[0],
    minY: sw.geometry.coordinates[1],
    maxX: ne.geometry.coordinates[0],
    maxY: ne.geometry.coordinates[1]
  });

  if (process.env.DEBUG) {
    debug({
      type: "fit",
      bbox: sw.geometry.coordinates.concat(ne.geometry.coordinates)
    });
    debug({
      type: "draw",
      geometry: turf.lineString(turf.bboxPolygon(bbox).geometry.coordinates[0])
        .geometry,
      style: {
        width: 0.5,
        color: DEBUG_COLOR_2,
        opacity: 0.9
      },
      fade: 3000
    });
    debug({
      type: "draw",
      geometry: turf.lineString(
        turf.envelope(turf.featureCollection([sw, ne])).geometry.coordinates[0]
      ).geometry,
      style: {
        width: 0.8,
        color: DEBUG_COLOR_2,
        opacity: 0.6
      }
    });

    var boxes = [];
    for (let candidate of candidates) {
      boxes.push(
        turf.lineString(
          turf.bboxPolygon([
            candidate.minX,
            candidate.minY,
            candidate.maxX,
            candidate.maxY
          ]).geometry.coordinates[0]
        ).geometry.coordinates
      );
    }
    if (boxes.length) {
      debug({
        type: "fit",
        bbox: turf.bbox(turf.multiLineString(boxes))
      });
      debug({
        type: "draw",
        geometry: turf.multiLineString(boxes).geometry,
        style: {
          width: 0.3,
          color: "#5AFF52",
          opacity: 0.9
        },
        fade: 5000
      });
    }
  }

  // get scores
  var a = heuristics(addition);

  var matches = [];
  for (let candidate of candidates) {
    const refs = this.edges.get(candidate.id);
    const coordinates = [];
    for (let ref of refs) {
      coordinates.push(this.vertices.get(ref));
    }
    const line = turf.lineString(coordinates);

    if (process.env.DEBUG) {
      debug({
        type: "fit",
        bbox: turf.bbox(turf.featureCollection([sw, ne, line]))
      });
      debug({
        type: "draw",
        geometry: turf.lineString(turf.envelope(line).geometry.coordinates[0])
          .geometry,
        style: {
          width: 0.5,
          color: DEBUG_COLOR_2,
          opacity: 0.95
        },
        fade: 2000
      });
      debug({
        type: "draw",
        geometry: line.geometry,
        style: {
          width: 4,
          color: DEBUG_COLOR_2,
          opacity: 0.7
        },
        fade: 2000
      });
    }

    var b = heuristics(line);
    var scores = compare(a, b);

    if (process.env.DEBUG) {
      debug({
        type: "log",
        message: "---"
      });
      for (let s of Object.keys(scores)) {
        debug({
          type: "log",
          message: s + ": " + scores[s].toFixed(6),
          color:
            "rgb(" +
            (100 + Math.round(Math.abs(scores[s] - 1) * 105)) +
            "," +
            (100 + Math.round(scores[s] * 50)) +
            "," +
            (100 + Math.round(scores[s] * 50)) +
            ");"
        });
      }
    }

    var weights = {
      distance: 1,
      scale: 1,
      straight: 1,
      curve: 1,
      scan: 1,
      terminal: 1,
      bearing: 1
    };

    var score = 0;
    for (let s of Object.keys(scores)) {
      score += scores[s] * weights[s];
    }

    if (score > 0) {
      var match = {
        id: candidate.id,
        line: line,
        score: score
      };
      for (let s of Object.keys(scores)) {
        match[s] = scores[s];
      }
      matches.push(match);
    }
  }

  var softmaxScores = softmax(
    matches.map(match => {
      return match.score;
    })
  );
  var i = 0;
  for (let sm of softmaxScores) {
    matches[i].softmax = sm;
    i++;
  }

  matches = matches.sort((a, b) => {
    return b.softmax - a.softmax;
  });

  if (process.env.DEBUG) {
    debug({
      type: "clear"
    });
    debug({
      type: "draw",
      geometry: matches[0].line.geometry,
      style: {
        color: DEBUG_COLOR_3,
        width: 7,
        opacity: 0.9
      },
      fade: 6000
    });
  }

  return matches;
};

Mashnet.prototype.match = function(scores) {
  if (!scores.length) {
    return 0;
  } else {
    const prediction = this.nn.run({
      distance: scores[0].distance,
      scale: scores[0].scale,
      straight: scores[0].straight,
      curve: scores[0].curve,
      scan: scores[0].scan,
      terminal: scores[0].terminal,
      bearing: scores[0].bearing,
      softmax: scores[0].softmax
    });
    return prediction.match;
  }
};

function compare(a, b) {
  const maxDistance = Math.max(a.distance, b.distance);
  const minDistance = Math.min(a.distance, b.distance);
  const scale = (a.distance + b.distance) / 100;
  if (scale > 1) scale = 1;
  const maxStraight = Math.max(a.straight, b.straight);
  const minStraight = Math.min(a.straight, b.straight);
  const maxCurve = Math.max(a.curve, b.curve);
  const minCurve = Math.min(a.curve, b.curve);

  const scan = similarity(a.scan, b.scan);
  const terminal = similarity(a.terminal, b.terminal);

  const bearingForward = bearingDistance(a.bearing, b.bearing);
  const bearingBack = bearingDistance(b.bearing, a.bearing);
  const bearing = Math.max(bearingForward, bearingBack);

  return {
    distance: minDistance / maxDistance,
    scale: scale,
    straight: minStraight / maxStraight,
    curve: minCurve / maxCurve,
    scan: scan,
    terminal: terminal,
    bearing: Math.abs(bearing - 180) / 180
  };
}

function bearingDistance(b1, b2) {
  const b1Rad = b1 * DEG2RAD;
  const b2Rad = b2 * DEG2RAD;
  const b1y = Math.cos(b1Rad);
  const b1x = Math.sin(b1Rad);
  const b2y = Math.cos(b2Rad);
  const b2x = Math.sin(b2Rad);
  const crossp = b1y * b2x - b2y * b1x;
  const dotp = b1x * b2x + b1y * b2y;
  if (crossp > 0) {
    return Math.acos(dotp) * RAD2DEG;
  } else {
    return -Math.acos(dotp) * RAD2DEG;
  }
}

function similarity(a, b) {
  var union = new Set();
  for (let scan of a) {
    union.add(scan);
  }
  for (let scan of b) {
    union.add(scan);
  }
  var overlap = new Set();
  for (let key of union) {
    if (a.has(key) && b.has(key)) {
      overlap.add(key);
    }
  }
  var sim = 0;
  if (union.size > 0) {
    sim = overlap.size / union.size;
  }

  if (process.env.DEBUG) {
    var abCells = [];
    var cCells = [];

    for (let scan of a) {
      abCells.push(
        turf.bboxPolygon(tilebelt.tileToBBOX(tilebelt.quadkeyToTile(scan)))
          .geometry.coordinates[0]
      );
    }
    for (let scan of b) {
      abCells.push(
        turf.bboxPolygon(tilebelt.tileToBBOX(tilebelt.quadkeyToTile(scan)))
          .geometry.coordinates[0]
      );
    }
    for (let scan of overlap) {
      cCells.push(
        turf.bboxPolygon(tilebelt.tileToBBOX(tilebelt.quadkeyToTile(scan)))
          .geometry.coordinates[0]
      );
    }

    debug({
      type: "draw",
      geometry: turf.multiLineString(abCells).geometry,
      style: {
        color: DEBUG_COLOR_3,
        opacity: 0.8
      },
      fade: 1000
    });
    debug({
      type: "draw",
      geometry: turf.multiLineString(cCells).geometry,
      style: {
        color: DEBUG_COLOR_4,
        opacity: 0.8
      },
      fade: 2500
    });
  }

  return sim;
}

function heuristics(line) {
  var buffer = 0.01;
  var z = 24;
  var zs = { min_zoom: z, max_zoom: z };
  const start = turf.point(line.geometry.coordinates[0]);
  const end = turf.point(
    line.geometry.coordinates[line.geometry.coordinates.length - 1]
  );

  var distance = turf.lineDistance(line, UNITS);
  var straight = turf.distance(start, end, UNITS);
  var curve = straight / distance;
  var indexes = cover.indexes(turf.buffer(line, buffer, UNITS).geometry, zs);
  var scan = new Set();
  for (let index of indexes) {
    scan.add(index);
  }

  var terminalIndexes = cover.indexes(
    turf.buffer(
      turf.multiPoint([
        line.geometry.coordinates[0],
        line.geometry.coordinates[line.geometry.coordinates.length - 1]
      ]),
      buffer * 2,
      UNITS
    ).geometry,
    zs
  );
  var terminal = new Set();
  for (let index of terminalIndexes) {
    terminal.add(index);
  }

  const bearing = turf.bearing(start, end);

  return {
    line: line,
    distance: distance,
    straight: straight,
    curve: curve,
    scan: scan,
    terminal: terminal,
    bearing: bearing
  };
}

Mashnet.prototype.merge = function(existing, addition) {
  // merge existing edge
  var metadata = this.metadata.get(existing);
  for (let property of Object.keys(addition)) {
    metadata[property] = addition[property];
  }
  this.metadata.set(existing, metadata);
};

Mashnet.prototype.add = function(addition) {
  if (process.env.DEBUG) {
    debug({
      type: "log",
      message: "ADD"
    });
    debug({
      type: "fit",
      bbox: turf.bbox(addition)
    });
    debug({
      type: "draw",
      geometry: addition.geometry,
      style: {
        width: 4,
        color: DEBUG_COLOR_1,
        opacity: 0.7
      },
      fade: 100000
    });
  }

  // add new edge
  // get candidates
  var buffer = 0.01;
  var bbox = turf.bbox(addition);
  var sw = turf.destination(turf.point(bbox.slice(0, 2)), buffer, 225, UNITS);
  var ne = turf.destination(turf.point(bbox.slice(2, 4)), buffer, 45, UNITS);

  var candidates = this.edgetree.search({
    minX: sw.geometry.coordinates[0],
    minY: sw.geometry.coordinates[1],
    maxX: ne.geometry.coordinates[0],
    maxY: ne.geometry.coordinates[1]
  });

  var nodes = new Map();
  var vertices = new Map();
  for (let candidate of candidates) {
    const refs = this.edges.get(candidate.id);

    for (let ref of refs) {
      vertices.set(ref, turf.point(this.vertices.get(ref)));
    }

    nodes.set(refs[0], vertices.get(refs[0]));
    nodes.set(refs[refs.length - 1], vertices.get(refs[refs.length - 1]));
  }

  if (process.env.DEBUG) {
    var lines = [];

    for (let candidate of candidates) {
      var coordinates = [];
      const refs = this.edges.get(candidate.id);

      for (let ref of refs) {
        coordinates.push(this.vertices.get(ref));
      }
      lines.push(coordinates);
    }

    debug({
      type: "fit",
      bbox: turf.bbox(turf.multiLineString(lines))
    });
    debug({
      type: "log",
      message: candidates.length + " edge candidates"
    });
    debug({
      type: "draw",
      geometry: turf.multiLineString(lines).geometry,
      style: {
        width: 2,
        color: DEBUG_COLOR_2,
        opacity: 0.7
      },
      fade: 100000
    });
    debug({
      type: "log",
      message: vertices.size + " vertex candidates"
    });
    var vertexPts = [];
    for (let vertex of vertices) {
      vertexPts.push(vertex[1].geometry.coordinates);
    }
    debug({
      type: "draw",
      geometry: turf.multiPoint(vertexPts).geometry,
      style: {
        width: 4,
        color: DEBUG_COLOR_2,
        opacity: 0.7
      },
      fade: 100000
    });

    debug({
      type: "log",
      message: nodes.size + " node candidates"
    });
    var nodePts = [];
    for (let node of nodes) {
      nodePts.push(node[1].geometry.coordinates);
    }
    debug({
      type: "draw",
      geometry: turf.multiPoint(nodePts).geometry,
      style: {
        width: 8,
        color: DEBUG_COLOR_3,
        opacity: 0.7
      },
      fade: 100000
    });
    debug({
      // todo: delete
      type: "fit",
      bbox: turf.bbox(turf.multiLineString(lines))
    });
  }

  const steps = [];
  for (let coordinate of addition.geometry.coordinates) {
    const nodeDistances = [];
    const vertexDistances = [];
    const pt = turf.point(coordinate);
    for (let node of nodes) {
      const distance = turf.distance(pt, node[1]);
      nodeDistances.push({
        id: node[0],
        distance: distance
      });
    }
    for (let vertex of vertices) {
      const distance = turf.distance(pt, vertex[1]);
      vertexDistances.push({
        id: vertex[0],
        distance: distance
      });
    }
    nodeDistances.sort((a, b) => {
      return a.distance - b.distance;
    });
    vertexDistances.sort((a, b) => {
      return a.distance - b.distance;
    });
    var closestNode;
    var closestVertex;
    if (nodeDistances.length) {
      closestNode = nodeDistances[0];
    }
    if (vertexDistances.length) {
      closestVertex = vertexDistances[0];
    }

    if (process.env.DEBUG) {
      for (item of nodeDistances) {
        var line = turf.lineString([
          coordinate,
          nodes.get(item.id).geometry.coordinates
        ]);
        debug({
          type: "draw",
          geometry: line.geometry,
          style: {
            width: 1,
            color: DEBUG_COLOR_1,
            opacity: 0.9
          },
          fade: 3000
        });
      }

      for (item of vertexDistances) {
        var line = turf.lineString([
          coordinate,
          vertices.get(item.id).geometry.coordinates
        ]);
        debug({
          type: "draw",
          geometry: line.geometry,
          style: {
            width: 1,
            color: DEBUG_COLOR_4,
            opacity: 0.9
          },
          fade: 3000
        });
      }
    }

    if (closestNode.distance <= MAX_NODE_SHIFT) {
      if (process.env.DEBUG) {
        debug({
          type: "draw",
          geometry: nodes.get(closestNode.id).geometry,
          style: {
            width: 20,
            color: DEBUG_COLOR_1,
            opacity: 0.9
          },
          fade: 8000
        });
      }
      steps.push({
        type: "node",
        id: closestNode.id
      });
      continue;
    } else if (closestVertex.distance <= MAX_VERTEX_SHIFT) {
      if (process.env.DEBUG) {
        debug({
          type: "draw",
          geometry: vertices.get(closestVertex.id).geometry,
          style: {
            width: 20,
            color: DEBUG_COLOR_1,
            opacity: 0.9
          },
          fade: 8000
        });
      }
      steps.push({
        type: "vertex",
        id: closestVertex.id
      });
      continue;
    } else {
      steps.push({
        type: "insert",
        id: "n?" + this.id++,
        coordinate: coordinate
      });
      continue;
    }
  }

  var next = steps.shift();
  var insert = [next];
  while (steps.length) {
    next = steps.shift();
    if (next) {
      insert.push(next);

      if (next.type === "node" || next.type === "vertex") {
        // insert edge
        const id = "e?" + this.id++;
        const refs = [];
        for (item of insert) {
          refs.push(item.id);
        }
        this.edges.set(id, refs);

        // normalize
        var start = this.nodes.get(refs[0]);
        if (start) {
          // update existing node
          start.add(id);
          this.nodes.set(refs[0], start);
        } else {
          // create new node
          this.nodes.set(next.id, new Set());
          // split edges
          for (let candidate of candidates) {
            const candidateRefs = this.edges.get(candidate.id);
            // todo: split edges if a vertex was upgraded
          }
        }
        var end = this.nodes.get(refs[refs.length - 1]);
        if (end) {
          // update existing node
          end.add(id);
          this.nodes.set(refs[refs.length - 1], end);
        } else {
          // create new node
          this.nodes.set(next.id, new Set());
          // split edges
          for (let candidate of candidates) {
            const candidateRefs = this.edges.get(candidate.id);
            // todo: split edges if a vertex was upgraded
          }
        }

        // new edge
        insert = [next];
      }
    }
  }
};

Mashnet.prototype.toJSON = function() {
  // serialize
  var json = {
    edges: [],
    vertices: [],
    nodes: [],
    metadata: [],
    nodetree: this.nodetree.toJSON(),
    edgetree: this.edgetree.toJSON(),
    id: this.id
  };

  for (let edge of this.edges) {
    json.edges.push(edge);
  }
  for (let vertex of this.vertices) {
    json.vertices.push(vertex);
  }
  for (let node of this.nodes) {
    json.nodes.push(node);
  }
  for (let data of this.metadata) {
    json.metadata.push(data);
  }

  return json;
};

Mashnet.prototype.fromJSON = function(json) {
  // deserialize
  for (let edge of json.edges) {
    this.edges.set(edge[0], edge[1]);
  }
  for (let vertex of json.vertices) {
    this.vertices.set(vertex[0], vertex[1]);
  }
  for (let node of json.nodes) {
    this.nodes.set(node[0], node[1]);
  }
  for (let data of json.metadata) {
    this.metadata.set(data[0], data[1]);
  }
  this.edgetree = this.edgetree.fromJSON(json.edgetree);
  this.nodetree = this.nodetree.fromJSON(json.nodetree);
  this.id = json.id;
};

module.exports = Mashnet;
