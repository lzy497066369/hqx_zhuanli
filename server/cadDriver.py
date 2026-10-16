# WORKDIR is injected by the trusted launcher. AI code never receives filesystem APIs.
import json, os, math, traceback
import builtins as _builtins
import types
import FreeCAD
import Part
import MeshPart

def compound(parts):
    # FreeCAD 1.1's C++ factory inspects caller globals; dispatch from this trusted
    # frame instead of the restricted exec namespace (otherwise Access violation).
    return Part.makeCompound(parts)

part_api = types.SimpleNamespace(**{key: getattr(Part, key) for key in ['makeBox', 'makeCylinder', 'makeCone', 'makeSphere', 'makeTorus', 'makePolygon', 'makeLine', 'makePlane', 'Face', 'Wire', 'Vertex']})
part_api.makeCompound = compound
freecad_api = types.SimpleNamespace(**{key: getattr(FreeCAD, key) for key in ['Vector', 'Rotation', 'Placement', 'Matrix']})

def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name not in {'FreeCAD', 'Part', 'math'}:
        raise ImportError('module not allowed: ' + str(name))
    if name == 'Part':
        return part_api
    if name == 'FreeCAD':
        return freecad_api
    return _builtins.__import__(name, globals, locals, fromlist, level)

safe = {key: getattr(_builtins, key) for key in ['abs', 'all', 'any', 'bool', 'dict', 'divmod', 'enumerate', 'filter', 'float', 'int', 'isinstance', 'len', 'list', 'map', 'max', 'min', 'pow', 'range', 'reversed', 'round', 'set', 'sorted', 'str', 'sum', 'tuple', 'zip', 'Exception', 'ValueError', 'TypeError', 'RuntimeError']}
safe['__import__'] = guarded_import

def checked_shapes(built):
    if not isinstance(built, dict) or not built or len(built) > 12:
        raise RuntimeError('build_model must return a dict of 1..12 numbered parts')
    result = {}
    for key, shape in built.items():
        key = str(key)
        if not key.isdigit() or not hasattr(shape, 'ShapeType') or shape.isNull() or not shape.isValid() or shape.Volume <= 1e-8:
            raise RuntimeError('invalid solid for part ' + key)
        result[key] = shape.removeSplitter()
    return result

def check_contact(shapes):
    # Check every solid, including connections inside a numbered assembly. A
    # subpart may connect through another subpart of the same assembly.
    nodes = [(key, i + 1, solid) for key, shape in shapes.items() for i, solid in enumerate(shape.Solids)]
    if len(nodes) < 2:
        return
    if len(nodes) > 512:
        raise RuntimeError('too many solid instances for contact verification')
    boxes = [solid.BoundBox for _, _, solid in nodes]
    def near(a, b):
        return (max(a.XMin - b.XMax, b.XMin - a.XMax) <= 0.05 and
                max(a.YMin - b.YMax, b.YMin - a.YMax) <= 0.05 and
                max(a.ZMin - b.ZMax, b.ZMin - a.ZMax) <= 0.05)
    # Connectivity only needs a spanning tree. Try cheap solid pairs first and
    # skip pairs already connected through other solids, while retaining the
    # same exact distance/tolerance for every edge we actually need to prove.
    parents = list(range(len(nodes)))
    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    face_counts = [len(solid.Faces) for _, _, solid in nodes]
    candidates = sorted((face_counts[i] * face_counts[j], i, j)
                        for i in range(len(nodes)) for j in range(i + 1, len(nodes))
                        if near(boxes[i], boxes[j]))
    remaining = len(nodes)
    for _, i, j in candidates:
        first, second = root(i), root(j)
        if first != second and nodes[i][2].distToShape(nodes[j][2])[0] <= 0.05:
            parents[second] = first
            remaining -= 1
            if remaining == 1:
                return
    connected = root(0)
    if remaining != 1:
        floating = ['%s(instance %s)' % (key, occurrence) for i, (key, occurrence, _) in enumerate(nodes) if root(i) != connected]
        raise RuntimeError('disconnected solid instances: ' + ', '.join(floating))

# Projection budget. The soft budget is what the tessellation loop aims for;
# the hard limit mirrors meshFigure.MAX_RENDER_TRIANGLES and is only reached by
# models that are genuinely too detailed to draw.
MESH_TRIANGLE_BUDGET = 100000
MESH_VERTEX_BUDGET = 300000
MESH_TRIANGLE_LIMIT = 120000
MESH_VERTEX_LIMIT = 400000

def mesh_of(shapes, section=None):
    box = Part.makeCompound(list(shapes.values())).BoundBox
    if not 0 < max(box.XLength, box.YLength, box.ZLength) <= 20000:
        raise RuntimeError('model dimensions out of range')
    def tessellate(tolerance, angular=0.18):
        vertices, triangles, owners, cut_faces, instances = [], [], [], [], []
        for key, assembly in shapes.items():
            # Preserve contact seams and distinct hatch directions for adjacent
            # constituents of one numbered assembly (e.g. two locking nuts).
            for occurrence, shape in enumerate(assembly.Solids):
                points, faces = MeshPart.meshFromShape(Shape=shape, LinearDeflection=tolerance, AngularDeflection=angular, Relative=False).Topology
                base = len(vertices)
                vertices.extend([[round(p.x, 5), round(p.y, 5), round(p.z, 5)] for p in points])
                triangles.extend([[int(i)+base for i in face] for face in faces])
                owners.extend([key] * len(faces))
                instances.extend([key + '-' + str(occurrence + 1)] * len(faces))
                axis = 'xyz'.index(section['axis']) if section else None
                cut_faces.extend([bool(section and all(abs(vertices[base+i][axis] - section['offset']) < 0.0002 for i in face)) for face in faces])
        return dict(vertices=vertices, triangles=triangles, parts=owners, sectionFaces=cut_faces, instances=instances)
    # Projection only needs the real structural edges, so a coarser
    # tessellation is always better than refusing to draw at all. Grow the
    # deflection by the measured overshoot instead of a fixed step: a model that
    # only just exceeds the budget (the common case) lands inside it after one
    # extra pass instead of failing the whole stage.
    base = max(box.DiagonalLength / 1000, 0.01)
    tolerance = base
    angular = 0.18
    mesh = tessellate(tolerance, angular)
    for _ in range(5):
        if len(mesh['triangles']) <= MESH_TRIANGLE_BUDGET and len(mesh['vertices']) <= MESH_VERTEX_BUDGET:
            break
        growth = max(1.6, (float(len(mesh['triangles'])) / MESH_TRIANGLE_BUDGET) ** 0.5 * 1.15,
                     (float(len(mesh['vertices'])) / MESH_VERTEX_BUDGET) ** 0.5 * 1.15)
        # Curved faces are often limited by the angular deflection rather than the
        # linear one, so both have to coarsen for the count to actually drop.
        tolerance = min(tolerance * growth, base * 8.0)
        angular = min(angular * growth, 0.6)
        mesh = tessellate(tolerance, angular)
    if len(mesh['triangles']) > MESH_TRIANGLE_LIMIT or len(mesh['vertices']) > MESH_VERTEX_LIMIT:
        raise RuntimeError('mesh too complex (%s triangles, %s vertices at deflection %.3f mm / %.3f rad); use fewer separate solids or drop repeated small curved details' % (len(mesh['triangles']), len(mesh['vertices']), tolerance, angular))
    return mesh, [box.XMin, box.YMin, box.ZMin, box.XMax, box.YMax, box.ZMax]

def section_of(shape, cutter):
    # Boolean operations on overlapping compounds can silently drop an entire
    # constituent. Clip each real solid once and preserve the separate pieces.
    pieces = []
    for solid in shape.Solids:
        clipped = solid.common(cutter).removeSplitter()
        if not clipped.isNull() and clipped.Volume > 1e-8:
            pieces.append(clipped)
    return Part.makeCompound(pieces) if pieces else None

class AnnotationFailure(RuntimeError):
    def __init__(self, findings):
        super().__init__('annotation endpoints must lie on their actual owner surfaces')
        self.findings = findings[:12]

def require_surface(shapes, endpoint, context, findings):
    label = str(endpoint.get('number', endpoint.get('text', '')))
    identity = '%s %s owner %s point %s' % (context, label, endpoint['owner'], endpoint['point'])
    shape = shapes.get(endpoint['owner'])
    if shape is None:
        findings.append(identity + ': annotation owner is absent from this figure')
        return
    boundary = Part.makeCompound(shape.Faces)
    vertex = Part.Vertex(FreeCAD.Vector(*endpoint['point']))
    distance, pairs, _ = vertex.distToShape(boundary)
    if distance > 0.05:
        nearest = pairs[0][1]
        point = [round(nearest.x, 6), round(nearest.y, 6), round(nearest.z, 6)]
        findings.append(identity + ': distance %.6f mm; nearest actual boundary %s. Keep the mark on the correct feature; this point is a geometric reference only.' % (distance, point))

try:
    with open(os.path.join(WORKDIR, 'ai_model.py'), encoding='utf-8') as f:
        code = f.read()
    with open(os.path.join(WORKDIR, 'drawing_plan.json'), encoding='utf-8') as f:
        options = json.load(f)
    namespace = {'__builtins__': safe, '__name__': 'ai_model'}
    exec(compile(code, 'ai_model.py', 'exec'), namespace)
    shapes = checked_shapes(namespace['build_model']())
    if options.get('components') and set(shapes) != set(options['components']):
        raise RuntimeError('part IDs must exactly match components: ' + ','.join(options['components']))
    if options.get('plan'):
        check_contact(shapes)
    mesh, bbox = mesh_of(shapes)
    plan = options.get('plan') or {}
    surface_findings = []
    for anchor in plan.get('anchors', []):
        require_surface(shapes, anchor, 'anchor mark', surface_findings)
    figures = []
    states = {None: shapes}
    for figure in plan.get('figures', []):
        state = figure.get('state') or None
        anchors = [dict(a) for a in plan.get('anchors', [])]
        if state and state not in states:
            state_fn = namespace.get('build_state')
            if not callable(state_fn):
                raise RuntimeError('state figure requires build_state(state, parts)')
            current = checked_shapes(state_fn(state, {key: shape.copy() for key, shape in shapes.items()}))
            if set(current) != set(shapes):
                raise RuntimeError('state cannot add or remove parts')
            for key, shape in current.items():
                original = shapes[key]
                if abs(shape.Volume - original.Volume) > max(.001, original.Volume * .00001) or abs(shape.Area-original.Area) > max(.001, original.Area * .00001):
                    raise RuntimeError('state must preserve geometry of part ' + key)
            check_contact(current)
            states[state] = current
        # Each named state is built and verified once. Figures receive copies
        # so sectioning cannot change a later figure of the same state.
        current = {key: shape.copy() for key, shape in states[state].items()}
        if state:
            for anchor in anchors:
                key = anchor['owner']
                transform = current[key].Placement.multiply(shapes[key].Placement.inverse())
                v = transform.multVec(FreeCAD.Vector(*anchor['point']))
                anchor['point'] = [v.x, v.y, v.z]
        if figure.get('parts'):
            current = {key: current[key] for key in figure['parts']}
        section = figure.get('section')
        if section:
            axis = 'xyz'.index(section['axis'])
            mins, sizes = [-30000., -30000., -30000.], [60000., 60000., 60000.]
            if section['keep'] == 'positive':
                mins[axis] = section['offset']
                sizes[axis] = 30000-section['offset']
            else:
                sizes[axis] = 30000+section['offset']
            # Models also place this field on the figure; validation checks both.
            depth = section.get('depth', figure.get('depth'))
            if depth is not None:
                sizes[axis] = depth
                mins[axis] = section['offset'] if section['keep'] == 'positive' else section['offset']-depth
            cutter = Part.makeBox(*sizes, FreeCAD.Vector(*mins))
            current = {key: section_of(shape, cutter) for key, shape in current.items()}
            current = {key: shape for key, shape in current.items() if shape is not None}
            if not current:
                raise RuntimeError('section removed all geometry')
        for inscription in figure.get('surfaceTexts', []):
            require_surface(current, inscription, figure['id'] + ' surface text', surface_findings)
        for dimension in figure.get('dimensions', []):
            require_surface(current, dimension['from'], figure['id'] + ' dimension from', surface_findings)
            require_surface(current, dimension['to'], figure['id'] + ' dimension to', surface_findings)
        figure_mesh, _ = mesh_of(current, section)
        if section and not any(figure_mesh['sectionFaces']):
            raise RuntimeError('section plane does not intersect solid')
        figures.append(dict(id=figure['id'], mesh=figure_mesh, anchors=anchors))
    if surface_findings:
        raise AnnotationFailure(surface_findings)
    result = dict(ok=True, version='.'.join(FreeCAD.Version()[:3]), bbox=bbox, **mesh, figures=figures)
except Exception as error:
    result = dict(ok=False, error='%s: %s' % (type(error).__name__, error), trace=traceback.format_exc()[-2000:])
    if isinstance(error, AnnotationFailure):
        result['findings'] = error.findings
with open(os.path.join(WORKDIR, 'mesh.json'), 'w', encoding='utf-8') as f:
    json.dump(result, f)
