import fs from "node:fs";
import path from "node:path";
const [target, mode] = process.argv.slice(2);
const temp = `${target}.${process.pid}.tmp`;
const next = JSON.stringify({ version: "new", payload: "x".repeat(8192) });
fs.mkdirSync(path.dirname(target), { recursive: true });
const fd = fs.openSync(temp, "wx");
if (mode === "during-write") {
  fs.writeSync(fd, next.slice(0, 20));
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
} else {
  fs.writeSync(fd, next); fs.fsyncSync(fd); fs.closeSync(fd); process.stdout.write("READY\n");
  if (mode === "before-rename") {
    setInterval(() => {}, 1000);
  } else if (mode === "replace") {
    setTimeout(() => {
      fs.renameSync(temp, target);
      process.stdout.write("RENAMED\n");
    }, 75);
  } else {
    fs.renameSync(temp, target); process.stdout.write("RENAMED\n");
  }
}
