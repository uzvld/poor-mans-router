# Apply/verify the local Hermes-core edits for the OMP thin-host provider.
# Usage:
#   python3 reapply_omp_patches.py [--check] [/path/to/hermes-agent]
# Exit 0 = all anchors present (or, with --check, would be applied).
# Exit 1 = a file needs hand reconciliation (anchor missing, old block moved).
import os
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else os.path.expanduser("~/.hermes/hermes-agent")
CHECK = "--check" in sys.argv


def read(rel: str) -> str:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def write(rel: str, data: str) -> None:
    with open(os.path.join(ROOT, rel), "w", encoding="utf-8") as f:
        f.write(data)


def apply(rel: str, needle: str, insert: str, anchor: str) -> bool:
    data = read(rel)
    if anchor in data:
        print(f"OK:   {rel} anchor present")
        return True
    if CHECK:
        print(f"OK:   {rel} would apply")
        return True
    if needle not in data:
        print(f"FAIL: {rel} — needle missing; reconcile by hand")
        return False
    write(rel, data.replace(needle, insert, 1))
    print(f"OK:   {rel} patched")
    return True


ok = True

# 1) Overlay so the picker enumerates omp (plugin registry is not enough).
ok &= apply(
    "hermes_cli/providers.py",
    (
        '"copilot-acp": HermesOverlay(transport="codex_responses", auth_type="external_process",\n'
        '                                 base_url_override="acp://copilot", base_url_env_var="COPILOT_ACP_BASE_URL"),'
    ),
    (
        '"copilot-acp": HermesOverlay(transport="codex_responses", auth_type="external_process",\n'
        '                                 base_url_override="acp://copilot", base_url_env_var="COPILOT_ACP_BASE_URL"),\n'
        '    "omp": HermesOverlay(transport="openai_chat", auth_type="external_process",\n'
        '                         base_url_override="rpc-ui://omp"),'
    ),
    '"omp": HermesOverlay(transport="openai_chat", auth_type="external_process"',
)

# 2) Display label.
ok &= apply(
    "hermes_cli/providers.py",
    '"copilot-acp": "GitHub Copilot ACP",',
    '"copilot-acp": "GitHub Copilot ACP", "omp": "Oh My Pi",',
    '"omp": "Oh My Pi"',
)

# 3) Aliases (oh-my-pi / omp-rpc → omp).
ok &= apply(
    "hermes_cli/providers.py",
    '"copilot-acp": ("github-copilot-acp",),',
    '"copilot-acp": ("github-copilot-acp",), "omp": ("oh-my-pi", "omp-rpc", "ohmyai"),',
    '"omp": ("oh-my-pi", "omp-rpc", "ohmyai")',
)

# 4) Canonical provider list — auto-extend skips external_process plugins.
ok &= apply(
    "hermes_cli/models_catalog_static.py",
    (
        '    ("copilot-acp", "GitHub Copilot ACP", "GitHub Copilot ACP (Spawns copilot --acp --stdio)"),\n'
    ),
    (
        '    ("copilot-acp", "GitHub Copilot ACP", "GitHub Copilot ACP (Spawns copilot --acp --stdio)"),\n'
        '    ("omp", "Oh My Pi", "Oh My Pi (native tools, Cursor/OpenCode models, skills via rpc-ui)"),\n'
    ),
    '("omp", "Oh My Pi",',
)

# 5) Picker model catalog from the plugin, not HTTP /models on rpc-ui://omp.
ok &= apply(
    "hermes_cli/model_switch_providers.py",
    '        if hermes_slug in {"openai-codex", "copilot", "copilot-acp"}:\n',
    (
        '        if hermes_slug == "omp":\n'
        "            try:\n"
        "                from providers import get_provider_profile\n"
        '                profile = get_provider_profile("omp")\n'
        "                model_ids = (profile.fetch_models(timeout=15.0) if profile else []) or []\n"
        "            except Exception:\n"
        "                model_ids = []\n"
        '        elif hermes_slug in {"openai-codex", "copilot", "copilot-acp"}:\n'
    ),
    'if hermes_slug == "omp":',
)

# --- Desktop renderer: the OMP row is a nested-provider catalog --------------
# The picker's default view hides models behind `featured_models` (5 per lab)
# and renders every id by its tail only, so a 700-model OMP row showed 28 rows
# and `openrouter/deepseek/deepseek-v4.1-flash` was indistinguishable from
# `opencode-go/deepseek-v4.1-flash`. `hermes update` rebuilds apps/desktop, so
# re-apply then rebuild: cd apps/desktop && npm run pack.

# 6) Every collapsed family stays visible by default for the omp row.
ok &= apply(
    "apps/desktop/src/store/model-visibility.ts",
    "/** Add a provider's curated default model keys to `target`. Prefers the",
    (
        "/** Aggregator rows whose full catalog IS the product. The Oh My Pi route nests\n"
        " *  independent providers (openrouter, cursor, opencode-go, …) in one row, so the\n"
        " *  backend's per-lab `featured_models` shortlist hides most of what the same OMP\n"
        " *  install lists in Paseo/Multica. Default these rows to every collapsed family;\n"
        " *  search and the Edit Models dialog behave exactly as before. */\n"
        "export const FULL_CATALOG_PROVIDER_SLUGS: Readonly<Record<string, true>> = { omp: true }\n"
        "\n"
        "/** Add a provider's curated default model keys to `target`. Prefers the"
    ),
    "export const FULL_CATALOG_PROVIDER_SLUGS",
)

ok &= apply(
    "apps/desktop/src/store/model-visibility.ts",
    (
        "  const defaults = featured.length\n"
        "    ? families.filter(family => featured.includes(family.id))\n"
        "    : families.slice(0, DEFAULT_VISIBLE_PER_PROVIDER)\n"
    ),
    (
        "  const defaults = FULL_CATALOG_PROVIDER_SLUGS[provider.slug] === true\n"
        "    ? families\n"
        "    : featured.length\n"
        "      ? families.filter(family => featured.includes(family.id))\n"
        "      : families.slice(0, DEFAULT_VISIBLE_PER_PROVIDER)\n"
    ),
    "FULL_CATALOG_PROVIDER_SLUGS[provider.slug] === true",
)

# 7) Label every id with the nested provider that serves it.
ok &= apply(
    "apps/desktop/src/lib/model-status-label.ts",
    "/** Split a model id into a clean display name plus an optional grayed variant",
    (
        "// Rows that nest OTHER providers under their own id: every model id is\n"
        "// `<route>/…`, so the route is the provider that actually serves it. The Oh My\n"
        "// Pi rpc-ui route is the only one — Hermes' own `openrouter` row lists\n"
        "// `vendor/model` ids where the head is a vendor, not a sibling provider.\n"
        "const NESTED_PROVIDER_ROWS: Readonly<Record<string, true>> = { omp: true }\n"
        "\n"
        "const NESTED_PROVIDER_LABELS: Readonly<Record<string, string>> = {\n"
        "  anthropic: 'Anthropic',\n"
        "  cursor: 'Cursor',\n"
        "  ollama: 'Ollama',\n"
        "  'openai-codex': 'OpenAI Codex',\n"
        "  'opencode-go': 'OpenCode Go',\n"
        "  'opencode-zen': 'OpenCode Zen',\n"
        "  openrouter: 'OpenRouter'\n"
        "}\n"
        "\n"
        "/** Display label for the nested route *model* is served through inside row\n"
        " *  *providerSlug*, or `''` when the row nests nothing — a plain `vendor/model`\n"
        " *  row keeps its existing label. `openrouter/deepseek/deepseek-v4.1-flash` and\n"
        " *  `opencode-go/deepseek-v4.1-flash` otherwise share one display name. */\n"
        "export function nestedProviderTag(model: string, providerSlug: string): string {\n"
        "  const row = providerSlug.trim().toLowerCase()\n"
        "\n"
        "  if (NESTED_PROVIDER_ROWS[row] !== true) {\n"
        "    return ''\n"
        "  }\n"
        "\n"
        "  const head = model.trim().split('/')[0].trim().toLowerCase()\n"
        "\n"
        "  if (!head || head === row) {\n"
        "    return ''\n"
        "  }\n"
        "\n"
        "  return NESTED_PROVIDER_LABELS[head] ?? prettifyBase(head)\n"
        "}\n"
        "\n"
        "/** Split a model id into a clean display name plus an optional grayed variant"
    ),
    "export function nestedProviderTag",
)

ok &= apply(
    "apps/desktop/src/lib/model-status-label.ts",
    "export function modelDisplayParts(model: string): { name: string; tag: string } {",
    "export function modelDisplayParts(model: string, providerSlug = ''): { name: string; tag: string } {",
    "export function modelDisplayParts(model: string, providerSlug = '')",
)

ok &= apply(
    "apps/desktop/src/lib/model-status-label.ts",
    "  return { name: prettifyBase(base) || model.trim() || 'No model', tag }",
    (
        "  // A nested route outranks the variant tag: two providers serving the same\n"
        "  // tail must not render identically, and the variant has its own pill.\n"
        "  const nested = nestedProviderTag(model, providerSlug)\n"
        "\n"
        "  if (nested) {\n"
        "    tag = tag ? `${nested} · ${tag}` : nested\n"
        "  }\n"
        "\n"
        "  return { name: prettifyBase(base) || model.trim() || 'No model', tag }"
    ),
    "const nested = nestedProviderTag(model, providerSlug)",
)

# 8) Show that route in the catalog row.
ok &= apply(
    "apps/desktop/src/app/shell/model-catalog-menu.tsx",
    "import { displayModelName, modelDisplayParts } from '@/lib/model-status-label'",
    "import { displayModelName, modelDisplayParts, nestedProviderTag } from '@/lib/model-status-label'",
    "import { displayModelName, modelDisplayParts, nestedProviderTag } from '@/lib/model-status-label'",
)

ok &= apply(
    "apps/desktop/src/app/shell/model-catalog-menu.tsx",
    (
        "                    const name = modelDisplayParts(family.id).name\n"
        "                    const caps = group.provider.capabilities?.[family.id]\n"
    ),
    (
        "                    const name = modelDisplayParts(family.id).name\n"
        "                    // The nested route this id comes from (`OpenRouter`, `OpenCode Go`):\n"
        "                    // an aggregator row can serve the same tail through several of them.\n"
        "                    const route = nestedProviderTag(family.id, group.provider.slug)\n"
        "                    const caps = group.provider.capabilities?.[family.id]\n"
    ),
    "const route = nestedProviderTag(family.id, group.provider.slug)",
)

ok &= apply(
    "apps/desktop/src/app/shell/model-catalog-menu.tsx",
    (
        "                    const meta = [\n"
        "                      fastControl.kind !== 'none' && fastControl.on ? copy.fast : null,\n"
    ),
    (
        "                    const meta = [\n"
        "                      route,\n"
        "                      fastControl.kind !== 'none' && fastControl.on ? copy.fast : null,\n"
    ),
    "route,\n                      fastControl.kind !== 'none'",
)

# 9) Edit Models shows the same label (it reads the shared parts helper).
ok &= apply(
    "apps/desktop/src/components/model-visibility-dialog.tsx",
    "const { name, tag } = modelDisplayParts(family.id)",
    "const { name, tag } = modelDisplayParts(family.id, provider.slug)",
    "modelDisplayParts(family.id, provider.slug)",
)

# 10) The omp row is never capped: the shared picker feeds the ACP catalog that
# Multica's `hermes` runtime reads, and ACP_MAX_MODELS_PER_PROVIDER (200) dropped
# whole nested providers (opencode-go, 470 of openrouter's 526).
ok &= apply(
    "hermes_cli/model_switch_providers.py",
    '_UNCAPPED_PICKER_PROVIDERS: frozenset[str] = frozenset({"opencode-zen", "opencode-go"})',
    (
        "# `omp` belongs here for the same reason: its rpc-ui row nests openrouter/cursor/opencode-go\n"
        "# (700+ ids), so any per-provider cap silently drops whole providers — the ACP catalog's 200\n"
        "# left `anthropic + cursor + openrouter[:56]` and no opencode-go at all.\n"
        '_UNCAPPED_PICKER_PROVIDERS: frozenset[str] = frozenset({"opencode-zen", "opencode-go", "omp"})'
    ),
    '"opencode-zen", "opencode-go", "omp"',
)

# 11) Opt-in agent handle. OMP runs its own tools, so Hermes never sees structured
# tool_calls for them and `_tool_activity_text` flattened every one into `[omp:bash]`
# prose (measured: 5674 markers / 0 structured rows on the hermes path vs 7750
# structured rows on the direct-omp path). With the agent, the client reports the same
# activity through `agent.tool_progress_callback`, which both the ACP adapter (Multica)
# and the desktop gateway install. Opt-in via the profile attribute, NEVER a new key in
# client_kwargs: that mapping is forwarded verbatim to SDK constructors, and widening it
# for every provider is what previously broke openai-codex and openrouter.
ok &= apply(
    "agent/agent_runtime_helpers.py",
    (
        "    try:\n"
        "        return profile.create_client(**client_kwargs)\n"
    ),
    (
        "    try:\n"
        "        # Opt-in ONLY, via a profile attribute — never a new key in ``client_kwargs``.\n"
        "        # That mapping is forwarded verbatim to SDK constructors (openai.OpenAI and\n"
        "        # friends), which reject unknown keywords: widening it for every provider is\n"
        "        # what previously broke openai-codex and openrouter. Agent-as-provider\n"
        "        # transports (the OMP thin host) execute their own tools and need the live\n"
        "        # agent to report that activity through ``agent.tool_progress_callback``;\n"
        "        # ordinary HTTP providers neither declare the flag nor see the extra argument.\n"
        '        if getattr(profile, "wants_agent_handle", False):\n'
        "            return profile.create_client(_hermes_agent=agent, **client_kwargs)\n"
        "        return profile.create_client(**client_kwargs)\n"
    ),
    'if getattr(profile, "wants_agent_handle", False):',
)

# 12) Document the opt-in on the profile contract so the next reader of base.py finds it.
ok &= apply(
    "providers/base.py",
    (
        "        ``plugins/model-providers/copilot-acp/`` for the in-tree example.\n"
        '        """\n'
    ),
    (
        "        ``plugins/model-providers/copilot-acp/`` for the in-tree example.\n"
        "\n"
        "        A profile that sets the class attribute ``wants_agent_handle = True``\n"
        "        additionally receives ``_hermes_agent=<AIAgent>``. Only declare it if the\n"
        "        transport runs its own tool loop and must report that activity back\n"
        "        through ``agent.tool_progress_callback`` (the OMP thin host does); the\n"
        "        argument is passed to nothing else, so ordinary SDK constructors never\n"
        "        see it.\n"
        '        """\n'
    ),
    "wants_agent_handle = True``",
)

print()
print("OMP provider integration: OK" if ok else "OMP provider integration: NEEDS HAND FIX")
print("Restart Hermes gateway after core edits: pkill -f 'hermes_cli.main gateway run'")
print("Desktop renderer edits need a rebuild: cd apps/desktop && npm run pack")
sys.exit(0 if ok else 1)
