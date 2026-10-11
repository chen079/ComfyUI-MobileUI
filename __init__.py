import json
import os

from aiohttp import web
from server import PromptServer  # type: ignore

from .convert import input_schema, schema_inputs, workflow_to_prompt

WEB_DIR = os.path.join(os.path.dirname(__file__), "web")

COMMON_PARAMS = {
    "seed", "noise_seed", "steps", "cfg", "sampler_name", "scheduler",
    "denoise", "width", "height", "batch_size", "ckpt_name", "unet_name",
}


def _workflows_dir(request):
    return PromptServer.instance.user_manager.get_request_user_filepath(request, "workflows", create_dir=False)


def _list_workflows(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames, key=str.lower):
            if not name.lower().endswith(".json"):
                continue
            path = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            category, _, filename = path.rpartition("/")
            out.append({
                "path": path,
                "name": filename[:-5],
                "category": category,
                "mtime": os.path.getmtime(os.path.join(dirpath, name)),
            })
    return out


def _is_link(value):
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str)


def _prompt_roles(prompt, schemas):
    # Follow each sampler's positive/negative input upstream to the first node that
    # holds the prompt text as a multiline string widget.
    roles = {}
    for node in prompt.values():
        sources = [("positive", "positive"), ("negative", "negative")]
        if node["class_type"].endswith("Guider"):
            sources.append(("conditioning", "positive"))
        for input_name, role in sources:
            link = node["inputs"].get(input_name)
            if not _is_link(link):
                continue
            queue, seen = [link[0]], set()
            while queue:
                node_id = queue.pop(0)
                if node_id in seen or node_id not in prompt:
                    continue
                seen.add(node_id)
                inputs = prompt[node_id]["inputs"]
                schema = schemas.get(node_id) or {}
                text = next((n for n, v in inputs.items() if isinstance(v, str) and _extra(schema.get(n)).get("multiline")), None)
                if text is not None:
                    roles.setdefault((node_id, text), role)
                    break
                queue.extend(v[0] for v in inputs.values() if _is_link(v))
    return roles


def _extra(spec):
    if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict):
        return spec[1]
    return {}


def _derive_widgets(prompt):
    schemas = {}
    for node_id, node in prompt.items():
        schema = input_schema(node["class_type"])
        if schema is not None:
            schemas[node_id] = schema_inputs(schema)
    roles = _prompt_roles(prompt, schemas)

    widgets = []
    for node_id, node in prompt.items():
        schema = schemas.get(node_id)
        if schema is None:
            continue
        for name, value in node["inputs"].items():
            spec = schema.get(name)
            if spec is None or _is_link(value):
                continue
            type_spec = spec[0] if isinstance(spec, (list, tuple)) and spec else None
            extra = _extra(spec)
            meta = {"node_id": node_id, "title": node["_meta"]["title"], "widget": name, "value": value}
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

            if (node_id, name) in roles:
                meta["group"] = roles[(node_id, name)]
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
    app.router.add_static('/webui/static', WEB_DIR)

    async def serve_index(request):
        return web.FileResponse(os.path.join(WEB_DIR, "index.html"))

    async def api_list_workflows(request):
        root = _workflows_dir(request)
        if root is None or not os.path.isdir(root):
            return web.json_response([])
        return web.json_response(_list_workflows(root))

    async def api_get_workflow(request):
        path = request.query.get("path", "")
        if not path.lower().endswith(".json"):
            return web.json_response({"error": "workflow not found"}, status=404)
        # get_request_user_filepath rejects paths that escape the user directory.
        full = PromptServer.instance.user_manager.get_request_user_filepath(request, "workflows/" + path, create_dir=False)
        if full is None or not os.path.isfile(full):
            return web.json_response({"error": "workflow not found"}, status=404)
        try:
            with open(full, "r", encoding="utf-8") as f:
                workflow = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            return web.json_response({"error": f"无法读取工作流：{e}"}, status=400)
        if not isinstance(workflow, dict) or "nodes" not in workflow:
            return web.json_response({"error": "不是界面格式的工作流文件"}, status=400)
        prompt = workflow_to_prompt(workflow)
        return web.json_response({
            "path": path,
            "prompt": prompt,
            "widgets": _derive_widgets(prompt),
        })

    app.router.add_routes([
        web.get('/webui', serve_index),
        web.get('/webui/api/workflows', api_list_workflows),
        web.get('/webui/api/workflow', api_get_workflow),
    ])


_add_routes()

NODE_CLASS_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS"]
