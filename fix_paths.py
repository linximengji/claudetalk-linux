"""Fix Windows paths in claudetalk TypeScript source files on server.
TS string literals like 'D:\\ClaudeProjects' store TWO backslashes in the file bytes.
"""
import os, sys

files_replacements = {
    # Each old string matches what's actually in the .ts file bytes:
    #   'D:\\ClaudeProjects'  →  chr(39) D : \ \ C l a u d e ... chr(39)
    "src/mcp-standalone.ts":        [(r"'D:\\ClaudeProjects'", "'/home/ubuntu/projects'")],
    "src/feishu-bridge.ts":         [(r"'D:\\ClaudeProjects'", "'/home/ubuntu/projects'")],
    "src/core/claude.ts":           [(r"'D:\\Tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'", "'/usr/local/bin/claude'")],
    "src/core/background-task.ts":  [(r"'D:\\Tools'", "'/home/ubuntu/tools'")],
    "src/index.ts":                 [(r"'C:\\'", "'/'"), (r"'D:\\'", "'/home/ubuntu/'")],
}

basedir = sys.argv[1] if len(sys.argv) > 1 else "."

for fpath, replacements in files_replacements.items():
    full = os.path.join(basedir, fpath)
    if not os.path.isfile(full):
        print(f"SKIP {fpath}: not found")
        continue
    with open(full, "r", encoding="utf-8") as f:
        content = f.read()
    for old, new in replacements:
        count = content.count(old)
        if count:
            content = content.replace(old, new)
            print(f"FIX {fpath}: {repr(old)} -> {repr(new)} ({count}x)")
        else:
            print(f"SKIP {fpath}: {repr(old)} not found")
    with open(full, "w", encoding="utf-8") as f:
        f.write(content)

# Index.ts disk mapping: C:\  and D:\  also appear in sysInfo template literal
# After the fix above, the C:\ and D:\ before the colon are already replaced.
# But the sysInfo line on index.ts:543 has template literal keys like:
#   disk['C:\\']? → disk['/']?
#   disk['D:\\']? → disk['/home/ubuntu/']?

print("\n-- verify --")
still_dirty = 0
for fpath in files_replacements:
    full = os.path.join(basedir, fpath)
    if os.path.isfile(full):
        with open(full) as f:
            for i, line in enumerate(f, 1):
                stripped = line.rstrip()
                if r"'C:\'" in stripped or r"'D:\'" in stripped:
                    print(f"  DIRTY {fpath}:{i}: {stripped[:100]}")
                    still_dirty += 1

if still_dirty:
    print(f"\n{still_dirty} lines still have Windows drive paths.")
else:
    print("All clean!")
