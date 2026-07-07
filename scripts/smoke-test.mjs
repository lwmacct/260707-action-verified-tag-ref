import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const actionPath = path.resolve("dist/index.js");

function main() {
  const repositoryPath = mkdtempSync(path.join(tmpdir(), "verified-tag-ref-smoke-"));
  git(repositoryPath, ["init", "--quiet"]);
  git(repositoryPath, ["config", "user.name", "Test User"]);
  git(repositoryPath, ["config", "user.email", "test@example.com"]);

  writeFileSync(path.join(repositoryPath, "file.txt"), "hello\n");
  git(repositoryPath, ["add", "file.txt"]);
  git(repositoryPath, ["commit", "--quiet", "-m", "initial"]);

  const sha = gitStdout(repositoryPath, ["rev-parse", "HEAD"]);
  git(repositoryPath, ["tag", "--no-sign", "v0.0.0-lightweight", "HEAD"]);
  git(repositoryPath, ["tag", "--no-sign", "-a", "v0.0.0-annotated", "HEAD", "-m", "annotated"]);

  runAction(repositoryPath, {
    INPUT_TAG: "v0.0.0-lightweight",
    INPUT_SHA: sha,
  });
  runAction(repositoryPath, {
    INPUT_TAG: "v0.0.0-annotated",
  });

  console.log("smoke-test ok");
}

function runAction(repositoryPath, env) {
  const result = spawnSync(process.execPath, [actionPath], {
    cwd: repositoryPath,
    env: {
      ...process.env,
      ...env,
      "INPUT_BASE-REF": "HEAD",
      INPUT_FETCH: "false",
      "INPUT_VALIDATE-CHECKOUT": "true",
      "INPUT_VALIDATE-REACHABLE": "true",
      "INPUT_TAG-PATTERN": "v*",
      INPUT_SUMMARY: "false",
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`action failed with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}

function git(repositoryPath, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
}

function gitStdout(repositoryPath, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

main();
