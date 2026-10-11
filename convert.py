# Convert a frontend (UI format) workflow into the API prompt that /prompt expects,
# following the frontend's graphToPrompt rules: muted/bypassed nodes, frontend-only
# nodes (Reroute, PrimitiveNode, notes) and subgraphs are resolved away.
import nodes
from comfy_api.internal import _ComfyNodeInternal

MODE_MUTED = 2
MODE_BYPASS = 4
SUBGRAPH_INPUT = -10
SUBGRAPH_OUTPUT = -20


def input_schema(class_type):
    cls = nodes.NODE_CLASS_MAPPINGS.get(class_type)
    if cls is None:
        return None
    try:
        if issubclass(cls, _ComfyNodeInternal):
            return cls.GET_NODE_INFO_V1()["input"]
        return cls.INPUT_TYPES()
    except Exception:
        return None


def schema_inputs(schema):
    out = {}
    for section in ("required", "optional"):
        for name, spec in (schema.get(section) or {}).items():
            out.setdefault(name, spec)
    return out


def _spec_extra(spec):
    if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict):
        return spec[1]
    return {}


class _Scope:
    def __init__(self, graph, prefix, parent=None, instance=None, subgraphs=None):
        self.prefix = prefix
        self.parent = parent
        self.instance = instance
        self.subgraphs = subgraphs
        self.nodes = {n["id"]: n for n in graph.get("nodes", [])}
        self.links = {}
        for link in graph.get("links", []):
            if isinstance(link, dict):
                self.links[link["id"]] = (link["origin_id"], link["origin_slot"], link["target_id"], link["target_slot"])
            else:
                self.links[link[0]] = (link[1], link[2], link[3], link[4])
        self.definition = graph
        self.instance_values = {}
        if instance is not None:
            self._map_instance_values()

    def _map_instance_values(self):
        # Widgets promoted from subgraph inputs are stored on the instance, in subgraph input order.
        values = self.instance.get("widgets_values")
        if not isinstance(values, list):
            return
        linked = {i.get("name") for i in self.instance.get("inputs", []) if i.get("link") is not None}
        idx = 0
        for slot, sg_input in enumerate(self.definition.get("inputs", [])):
            if not _is_widget_type(sg_input.get("type")):
                continue
            if idx >= len(values):
                break
            if sg_input.get("name") not in linked:
                self.instance_values[slot] = values[idx]
            idx += 1

    def full_id(self, node_id):
        return self.prefix + str(node_id)

    def child(self, node):
        return _Scope(self.subgraphs[node["type"]], self.full_id(node["id"]) + ":", self, node, self.subgraphs)


def _is_widget_type(t):
    return t in ("INT", "FLOAT", "STRING", "BOOLEAN", "COMBO")


_NO_LINK = object()


def _resolve_link(scope, link_id):
    """Return (full_node_id, slot), ("value", v) or _NO_LINK."""
    link = scope.links.get(link_id)
    if link is None:
        return _NO_LINK
    origin_id, origin_slot = link[0], link[1]
    return _resolve_output(scope, origin_id, origin_slot)


def _resolve_output(scope, origin_id, origin_slot):
    if origin_id == SUBGRAPH_INPUT:
        instance = scope.instance
        sg_input = scope.definition["inputs"][origin_slot]
        for inp in instance.get("inputs", []):
            if inp.get("name") == sg_input.get("name") and inp.get("link") is not None:
                return _resolve_link(scope.parent, inp["link"])
        if origin_slot in scope.instance_values:
            return ("value", scope.instance_values[origin_slot])
        return _NO_LINK

    node = scope.nodes.get(origin_id)
    if node is None:
        return _NO_LINK
    mode = node.get("mode", 0)
    if mode == MODE_MUTED:
        return _NO_LINK
    node_type = node.get("type")

    if node_type in scope.subgraphs:
        if mode == MODE_BYPASS:
            return _resolve_bypass(scope, node, origin_slot)
        inner = scope.child(node)
        for link in inner.links.values():
            if link[2] == SUBGRAPH_OUTPUT and link[3] == origin_slot:
                return _resolve_output(inner, link[0], link[1])
        return _NO_LINK

    if node_type == "Reroute":
        inputs = node.get("inputs", [])
        if inputs and inputs[0].get("link") is not None:
            return _resolve_link(scope, inputs[0]["link"])
        return _NO_LINK

    if mode == MODE_BYPASS:
        return _resolve_bypass(scope, node, origin_slot)

    if node_type not in nodes.NODE_CLASS_MAPPINGS:
        # PrimitiveNode and other frontend-only nodes: the target keeps its own widget value.
        return _NO_LINK

    return (scope.full_id(origin_id), origin_slot)


def _resolve_bypass(scope, node, slot):
    outputs = node.get("outputs", [])
    if slot >= len(outputs):
        return _NO_LINK
    out_type = outputs[slot].get("type")
    inputs = node.get("inputs", [])
    candidates = []
    if slot < len(inputs):
        candidates.append(inputs[slot])
    candidates += inputs
    for inp in candidates:
        if inp.get("type") == out_type and inp.get("link") is not None:
            return _resolve_link(scope, inp["link"])
    return _NO_LINK


def _spec_type(spec):
    if isinstance(spec, (list, tuple)) and spec:
        return "COMBO" if isinstance(spec[0], list) else spec[0]
    return None


def _has_control(name, spec):
    # The frontend adds a hidden "control after generate" widget value after these.
    extra = _spec_extra(spec)
    if "control_after_generate" in extra:
        return bool(extra["control_after_generate"])
    return _spec_type(spec) == "INT" and name in ("seed", "noise_seed")


def _widget_specs(schema, ui_inputs, prefix=""):
    """Yield (name, spec) for every widget in the order the frontend stores widgets_values."""
    for name, spec in schema.items():
        t = _spec_type(spec)
        full = prefix + name
        ui = ui_inputs.get(full)
        if t == "COMFY_DYNAMICCOMBO_V3":
            yield full, spec, _spec_extra(spec).get("options") or []
            continue
        # Every socket is listed in the node's UI inputs, so an unlisted input of an
        # unknown type is a custom frontend widget (e.g. a color picker).
        if _is_widget_type(t) or (ui is not None and ui.get("widget")) or (ui is None and t is not None and not _is_socket_type(t)):
            yield full, spec, None


def _is_socket_type(t):
    return not isinstance(t, str) or t in _SOCKET_TYPES or t == "*" or "," in t


_SOCKET_TYPES = {
    "MODEL", "CLIP", "VAE", "CONDITIONING", "LATENT", "IMAGE", "MASK", "CONTROL_NET", "CLIP_VISION",
    "CLIP_VISION_OUTPUT", "STYLE_MODEL", "GLIGEN", "UPSCALE_MODEL", "SAMPLER", "SIGMAS", "NOISE",
    "GUIDER", "AUDIO", "VIDEO", "WEBCAM", "PHOTOMAKER", "HOOKS", "TIMESTEPS_RANGE",
}


def _widget_values(node, schema):
    values = node.get("widgets_values")
    if isinstance(values, dict):
        return {k: v for k, v in values.items() if k in schema}
    if not isinstance(values, list):
        return {}

    ui_inputs = {i.get("name"): i for i in node.get("inputs", [])}
    out = {}
    idx = 0

    def consume(specs):
        nonlocal idx
        for name, spec, options in specs:
            if idx >= len(values):
                return
            value = values[idx]
            out[name] = value
            idx += 1
            if options is not None:
                for opt in options:
                    if opt.get("key") == value:
                        consume(_widget_specs(schema_inputs(opt.get("inputs") or {}), ui_inputs, name + "."))
                        break
                continue
            if _has_control(name.rsplit(".", 1)[-1], spec):
                idx += 1
            if _spec_extra(spec).get("image_upload") or _spec_extra(spec).get("video_upload") or _spec_extra(spec).get("audio_upload"):
                idx += 1

    consume(_widget_specs(schema, ui_inputs))
    return out


def _convert_scope(scope, prompt):
    for node_id, node in scope.nodes.items():
        mode = node.get("mode", 0)
        if mode in (MODE_MUTED, MODE_BYPASS):
            continue
        class_type = node.get("type")
        if class_type in scope.subgraphs:
            _convert_scope(scope.child(node), prompt)
            continue
        schema = input_schema(class_type)
        if schema is None:
            continue
        schema = schema_inputs(schema)

        inputs = _widget_values(node, schema)
        for inp in node.get("inputs", []):
            name = inp.get("name")
            if inp.get("link") is None or name not in schema:
                continue
            resolved = _resolve_link(scope, inp["link"])
            if resolved is _NO_LINK:
                continue
            if resolved[0] == "value":
                inputs[name] = resolved[1]
            else:
                inputs[name] = [resolved[0], resolved[1]]

        prompt[scope.full_id(node_id)] = {
            "class_type": class_type,
            "inputs": inputs,
            "_meta": {"title": node.get("title") or class_type},
        }


def workflow_to_prompt(workflow):
    subgraphs = {s["id"]: s for s in workflow.get("definitions", {}).get("subgraphs", [])}
    prompt = {}
    _convert_scope(_Scope(workflow, "", subgraphs=subgraphs), prompt)
    return prompt
