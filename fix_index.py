"""Fix the index.ts sysInfo template literal disk keys."""
fpath = "/home/ubuntu/projects/claudetalk/src/index.ts"
with open(fpath, "r", encoding="utf-8") as f:
    content = f.read()

# Current: disk['/\\']  and  disk['/home/ubuntu/\\']
# Fix: both should be disk['/'] on Linux (single root filesystem)
content = content.replace("disk['/\\\\']", "disk['/']")
content = content.replace("disk['/home/ubuntu/\\\\']", "disk['/']")

with open(fpath, "w", encoding="utf-8") as f:
    f.write(content)
print("Fixed index.ts disk keys")
