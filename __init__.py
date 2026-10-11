import glob
import json
import os

from aiohttp import web
from server import PromptServer  # type: ignore

import nodes
from comfy_api.internal import _ComfyNodeInternal

PLUGIN_DIR = os.path.dirname(__file__)
WORKFLOWS_DIR = os.path.join(PLUGIN_DIR, "workflows")
WEB_DIR = os.path.join(PLUGIN_DIR, "web")

COMMON_PARAMS = {
    "seed", "noise_seed", "steps", "cfg", "sampler_name", "scheduler",
    "denoise", "width", "height", "batch_size", "ckpt_name", "unet_name",
}


def _list_workflows():
    out = []
    for path in sorted(glob.glob(os.path.join(WORKFLOWS_DIR, "*.json"))):
        name = os.path.splitext(os.path.basename(path))[0]
        out.append({"id": name, "name": name})
    return out


def _load_workflow(workflow_id):
    if not workflow_id or workflow_id != os.path.basename(workflow_id):
        return None
    path = os.path.abspath(os.path.join(WORKFLOWS_DIR, workflow_id + ".json"))
    if os.path.commonpath((os.path.abspath(WORKFLOWS_DIR), path)) != os.path.abspath(WORKFLOWS_DIR):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    # Accept both the bare prompt graph and a full {"prompt": ...} request body.
    if isinstance(data, dict) and isinstance(data.get("prompt"), dict):
        return data["prompt"]
    if isinstance(data, dict):
        return data
    return None


def _input_schema(class_type):
    cls = nodes.NODE_CLASS_MAPPINGS.get(class_type)
    if cls is None:
        return None
    try:
        if issubclass(cls, _ComfyNodeInternal):
            return cls.GET_NODE_INFO_V1()["input"]
        return cls.INPUT_TYPES()
    except Exception:
        return None


def _derive_widgets(prompt):
    # Trace positive/negative links back to their text-encoding nodes so the
    # prompt textareas can be labelled exactly.
    roles = {}
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        for role in ("positive", "negative"):
            link = node.get("inputs", {}).get(role)
            if isinstance(link, list) and len(link) == 2 and isinstance(link[0], str):
                roles[link[0]] = role

    widgets = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        inputs = node.get("inputs", {})
        schema = _input_schema(class_type)
        if schema is None:
            continue
        title = node.get("_meta", {}).get("title") or class_type

        for section in ("required", "optional"):
            declared = schema.get(section) or {}
            for name, spec in declared.items():
                if name not in inputs:
                    continue
                value = inputs[name]
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                    continue  # link
                type_spec = spec[0] if isinstance(spec, (list, tuple)) and spec else None
                extra = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 else {}

                meta = {
                    "node_id": node_id,
                    "title": title,
                    "widget": name,
                    "value": value,
                }
                if isinstance(type_spec, list):
                    meta["type"] = "combo"
                    meta["options"] = type_spec
                elif type_spec == "COMBO":
                    meta["type"] = "combo"
                    meta["options"] = extra.get("options") or []
                elif type_spec in ("INT", "FLOAT"):
                    meta["type"] = type_spec
                    for k in ("min", "max", "step"):
                        if k in extra:
                            meta[k] = extra[k]
                elif type_spec == "STRING":
                    meta["type"] = "STRING"
                    meta["multiline"] = bool(extra.get("multiline"))
                elif type_spec == "BOOLEAN":
                    meta["type"] = "BOOLEAN"
                else:
                    continue

                if name == "text" and node_id in roles:
                    meta["group"] = roles[node_id]
                elif name in COMMON_PARAMS:
                    meta["group"] = "common"
                else:
                    meta["group"] = "other"
                widgets.append(meta)
    return widgets


def _add_routes():
    app = PromptServer.instance.app

    # Static files served outside WEB_DIRECTORY so the desktop editor never
    # auto-loads app.js as an extension script.
    app.router.add_static('/mobileui/static', WEB_DIR)

    async def serve_index(request):
        return web.FileResponse(os.path.join(WEB_DIR, "index.html"))

    async def api_list_workflows(request):
        return web.json_response(_list_workflows())

    async def api_get_workflow(request):
        prompt = _load_workflow(request.match_info.get("workflow_id", ""))
        if prompt is None:
            return web.json_response({"error": "workflow not found"}, status=404)
        return web.json_response({
            "id": request.match_info["workflow_id"],
            "prompt": prompt,
            "widgets": _derive_widgets(prompt),
        })

    app.router.add_routes([
        web.get('/mobileui', serve_index),
        web.get('/mobileui/api/workflows', api_list_workflows),
        web.get('/mobileui/api/workflows/{workflow_id}', api_get_workflow),
    ])


_add_routes()

NODE_CLASS_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS"]
