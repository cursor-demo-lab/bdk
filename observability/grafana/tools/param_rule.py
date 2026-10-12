#!/usr/bin/env python3
"""AST checks for generate.py and tools/: annotations, no adjacent same type, one positional.

    python3 tools/param_rule.py                 # scan this folder's Python
    python3 tools/param_rule.py --annotations a.py
    python3 tools/param_rule.py --positional a.py

Prints a JSON list of findings. Exit 1 when the list is not empty.

Dataclass constructors synthesise __init__ from field order. Without
kw_only=True that is the exact adjacent-same-type function the rule
forbids, and a swapped Copy(title, desc) or Size(w, h) is silent.
Every ClassDef decorated @dataclass must therefore set kw_only=True
(regardless of its field types). Call flags more than one positional
argument to a name bound to a dataclass in the module.
"""
import argparse
import ast
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def norm(text: str | None) -> str | None:
    if text is None:
        return None
    s = text.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1]
    changed = True
    while changed:
        changed = False
        if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
            s, changed = s[1:-1], True
            continue
        m = re.fullmatch(r"(?:typing|t)\.(.+)", s)
        if m:
            s, changed = m.group(1).strip(), True
            continue
        m = re.fullmatch(r"Optional\[(.*)\]", s)
        if m:
            s, changed = m.group(1).strip(), True
            continue
        m = re.fullmatch(r"Union\[(.+?),\s*None\]", s)
        if m:
            s, changed = m.group(1).strip(), True
            continue
        m = re.fullmatch(r"Union\[None,\s*(.+)\]", s)
        if m:
            s, changed = m.group(1).strip(), True
            continue
        m = re.fullmatch(r"(.+?)\s*\|\s*None", s)
        if m:
            s, changed = m.group(1).strip(), True
            continue
        m = re.fullmatch(r"None\s*\|\s*(.+)", s)
        if m:
            s, changed = m.group(1).strip(), True
    return s


def annotation_of(arg: ast.arg) -> str | None:
    return norm(ast.unparse(arg.annotation)) if arg.annotation is not None else None


def const_type(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Constant) and node.value is not None:
        return type(node.value).__name__
    return None


def default_type(fn: ast.FunctionDef | ast.AsyncFunctionDef, *, index: int, keyword: bool) -> str | None:
    if keyword:
        return const_type(fn.args.kw_defaults[index])
    defaults = fn.args.defaults
    if not defaults:
        return None
    n_args = len([a for a in fn.args.posonlyargs + fn.args.args if a.arg not in ("self", "cls")])
    idx = index - (n_args - len(defaults))
    if idx < 0:
        return None
    return const_type(defaults[idx])


def dataclass_kw_only(node: ast.ClassDef) -> bool | None:
    """True if kw_only=True, False if a dataclass without it, else None."""
    for dec in node.decorator_list:
        call = dec if isinstance(dec, ast.Call) else None
        func = call.func if call is not None else dec
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
        if name != "dataclass":
            continue
        if call is None:
            return False
        for kw in call.keywords:
            if kw.arg == "kw_only" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                return True
        return False
    return None


def call_func_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def scan_annotations(path: str) -> list[str]:
    bad = []
    tree = ast.parse(open(path, encoding="utf-8").read())
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef):
            kw_only = dataclass_kw_only(n)
            if kw_only is False:
                bad.append(f"{path}:{n.lineno} {n.name}: @dataclass must set kw_only=True")
            continue
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        args = [a for a in n.args.posonlyargs + n.args.args if a.arg not in ("self", "cls")]
        kw = list(n.args.kwonlyargs)
        extra = [a for a in (n.args.vararg, n.args.kwarg) if a is not None]
        for a in args + kw + extra:
            if a.annotation is None:
                bad.append(f"{path}:{n.lineno} {n.name}.{a.arg}: unannotated")
        params = [(a, annotation_of(a), default_type(n, index=i, keyword=False)) for i, a in enumerate(args)]
        params += [(a, annotation_of(a), default_type(n, index=i, keyword=True)) for i, a in enumerate(kw)]
        for (a, ta, da), (b, tb, db) in zip(params, params[1:]):
            why = []
            if ta and tb and ta == tb:
                why.append(f"annotation {ta}")
            if da and db and da == db:
                why.append(f"default {da}")
            if why:
                bad.append(f"{path}:{n.lineno} {n.name}({a.arg}, {b.arg}): {' and '.join(why)}")
    return bad


def module_dataclass_names(tree: ast.AST) -> set[str]:
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef) and dataclass_kw_only(n) is not None:
            names.add(n.name)
    return names


def scan_positional(path: str) -> list[str]:
    bad = []
    tree = ast.parse(open(path, encoding="utf-8").read())
    dataclasses = module_dataclass_names(tree)
    for n in ast.walk(tree):
        if isinstance(n, ast.Call):
            if isinstance(n.func, ast.Name) and n.func.id in dataclasses and len(n.args) >= 1:
                bad.append(f"{path}:{n.lineno} {n.func.id}({len(n.args)} positional)")
            continue
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        pos = [a.arg for a in n.args.posonlyargs + n.args.args if a.arg not in ("self", "cls")]
        if len(pos) > 1 or n.args.vararg:
            bad.append(f"{path}:{n.lineno} {getattr(n, 'name', 'lambda')}({', '.join(pos)})")
    return bad


def default_files() -> list[str]:
    names = [os.path.join(ROOT, f) for f in os.listdir(ROOT) if f.endswith(".py")]
    names += [os.path.join(HERE, f) for f in os.listdir(HERE) if f.endswith(".py")]
    return sorted(names)


def self_test() -> list[str]:
    """Direct norm() cases, including typing. / t. prefixes (N1)."""
    cases = {
        "str": "str",
        '"str"': "str",
        "str | None": "str",
        "None | str": "str",
        "Optional[str]": "str",
        "Union[str, None]": "str",
        "Union[None, str]": "str",
        "typing.Optional[str]": "str",
        "t.Optional[str]": "str",
        "typing.Union[str, None]": "str",
        "t.Union[None, str]": "str",
        "typing.Optional[str] | None": "str",
        'Optional["str"]': "str",
        '"str | None"': "str",
    }
    bad = []
    for raw, want in cases.items():
        got = norm(raw)
        if got != want:
            bad.append(f"norm({raw!r}) -> {got!r} != {want!r}")
    fixtures = [
        ("v8.py", "@dataclass\nclass V8:\n    a: int\n    b: str\n", "annotations",
         "kw_only=True"),
        ("v13.py", "def pair(a: Optional[\"str\"], b: \"str | None\"):\n    return a or b\n",
         "annotations", "annotation"),
        ("v14.py", "@dataclass(frozen=True, kw_only=True)\nclass P:\n    x: str\n    y: int = 0\n\nP(\"a\", y=1)\n",
         "positional", "positional"),
    ]
    tmp = os.path.join(HERE, "_param_rule_self_test")
    os.makedirs(tmp, exist_ok=True)
    try:
        for name, src, mode, needle in fixtures:
            path = os.path.join(tmp, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write("from dataclasses import dataclass\nfrom typing import Optional\n" + src)
            rows = scan_annotations(path) if mode == "annotations" else scan_positional(path)
            if not any(needle in row for row in rows):
                bad.append(f"{name}: expected {needle!r} in {rows}")
    finally:
        for name in os.listdir(tmp):
            os.remove(os.path.join(tmp, name))
        os.rmdir(tmp)
    return bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Parameter annotation and positional-arity checks.")
    ap.add_argument("files", nargs="*")
    ap.add_argument("--annotations", action="store_true")
    ap.add_argument("--positional", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        bad = self_test()
        print(json.dumps(bad))
        return 1 if bad else 0
    files = args.files or default_files()
    both = not args.annotations and not args.positional
    bad = []
    for path in files:
        if both or args.annotations:
            bad += scan_annotations(path)
        if both or args.positional:
            bad += scan_positional(path)
    print(json.dumps(bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
