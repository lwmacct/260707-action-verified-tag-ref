import * as core from "@actions/core";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Inputs {
  repositoryPath: string;
  tag: string;
  sha: string;
  baseRef: string;
  remote: string;
  fetch: boolean;
  validateCheckout: boolean;
  validateReachable: boolean;
  tagPattern: string;
  summary: boolean;
}

interface BaseRef {
  input: string;
  localRef: string;
  fetchRefspec: string;
}

interface VerificationResult {
  tag: string;
  sha: string;
  tagSha: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  repositoryPath: string;
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const result = await verifyTagRef(inputs);
    setOutputs(result);
    if (inputs.summary) {
      await writeSummary(result);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Unexpected failure");
  }
}

function getInputs(): Inputs {
  const tag = core.getInput("tag", { required: true });
  const repositoryPath = path.resolve(core.getInput("repository-path") || ".");
  const baseRef = core.getInput("base-ref") || "main";
  const remote = core.getInput("remote") || "origin";

  if (!tag.trim()) {
    throw new Error("tag is required");
  }
  if (!baseRef.trim()) {
    throw new Error("base-ref is required");
  }
  if (!remote.trim()) {
    throw new Error("remote is required");
  }

  return {
    repositoryPath,
    tag,
    sha: core.getInput("sha").trim(),
    baseRef,
    remote,
    fetch: getBooleanInput("fetch"),
    validateCheckout: getBooleanInput("validate-checkout"),
    validateReachable: getBooleanInput("validate-reachable"),
    tagPattern: core.getInput("tag-pattern"),
    summary: getBooleanInput("summary"),
  };
}

async function verifyTagRef(inputs: Inputs): Promise<VerificationResult> {
  if (inputs.tagPattern && !matchesGlob(inputs.tag, inputs.tagPattern)) {
    throw new Error(`tag ${inputs.tag} does not match pattern ${inputs.tagPattern}`);
  }
  await assertGitRef(`refs/tags/${inputs.tag}`, "tag");
  assertShaInput(inputs.sha);

  const baseRef = resolveBaseRef(inputs.baseRef, inputs.remote);
  if (!isSha(baseRef.localRef) && baseRef.localRef !== "HEAD") {
    await assertGitRef(baseRef.localRef, "base-ref");
  }

  if (inputs.fetch) {
    await fetchTag(inputs);
    if (inputs.validateReachable && baseRef.fetchRefspec) {
      await fetchBaseRef(inputs, baseRef);
    }
  }

  const tagSha = await gitStdout(inputs.repositoryPath, ["rev-parse", `refs/tags/${inputs.tag}^{commit}`]);
  const releaseSha = inputs.sha || tagSha;
  if (tagSha !== releaseSha) {
    throw new Error(`${inputs.tag} points to ${tagSha}, not ${releaseSha}`);
  }

  const headSha = await gitStdout(inputs.repositoryPath, ["rev-parse", "HEAD"]);
  if (inputs.validateCheckout && headSha !== releaseSha) {
    throw new Error(`Checked out ${headSha}, not ${releaseSha}`);
  }

  let baseSha = "";
  if (inputs.validateReachable) {
    baseSha = await gitStdout(inputs.repositoryPath, ["rev-parse", `${baseRef.localRef}^{commit}`]);
    await assertAncestor(inputs.repositoryPath, releaseSha, baseRef.localRef, inputs.tag);
  }

  core.info(`Verified ${inputs.tag} at ${releaseSha}`);
  return {
    tag: inputs.tag,
    sha: releaseSha,
    tagSha,
    headSha,
    baseRef: baseRef.localRef,
    baseSha,
    repositoryPath: inputs.repositoryPath,
  };
}

async function fetchTag(inputs: Inputs): Promise<void> {
  core.info(`Fetching tag ${inputs.tag} from ${inputs.remote}`);
  await git(inputs.repositoryPath, ["fetch", "--force", inputs.remote, `refs/tags/${inputs.tag}:refs/tags/${inputs.tag}`]);
}

async function fetchBaseRef(inputs: Inputs, baseRef: BaseRef): Promise<void> {
  core.info(`Fetching base ref ${baseRef.input} from ${inputs.remote}`);
  await git(inputs.repositoryPath, ["fetch", "--force", inputs.remote, baseRef.fetchRefspec]);
}

async function assertAncestor(repositoryPath: string, releaseSha: string, baseRef: string, tag: string): Promise<void> {
  try {
    await git(repositoryPath, ["merge-base", "--is-ancestor", releaseSha, baseRef]);
  } catch {
    throw new Error(`${tag} commit ${releaseSha} is not reachable from ${baseRef}`);
  }
}

function resolveBaseRef(value: string, remote: string): BaseRef {
  if (value === "HEAD" || isSha(value)) {
    return { input: value, localRef: value, fetchRefspec: "" };
  }
  if (value.startsWith(`refs/remotes/${remote}/`)) {
    const branch = value.slice(`refs/remotes/${remote}/`.length);
    return {
      input: value,
      localRef: value,
      fetchRefspec: `refs/heads/${branch}:${value}`,
    };
  }
  if (value.startsWith("refs/remotes/")) {
    return { input: value, localRef: value, fetchRefspec: "" };
  }
  if (value.startsWith("refs/heads/")) {
    const branch = value.slice("refs/heads/".length);
    const localRef = `refs/remotes/${remote}/${branch}`;
    return {
      input: value,
      localRef,
      fetchRefspec: `${value}:${localRef}`,
    };
  }
  if (value.startsWith(`${remote}/`)) {
    const branch = value.slice(remote.length + 1);
    const localRef = `refs/remotes/${remote}/${branch}`;
    return {
      input: value,
      localRef,
      fetchRefspec: `refs/heads/${branch}:${localRef}`,
    };
  }
  if (value.startsWith("refs/")) {
    return {
      input: value,
      localRef: "refs/action/base",
      fetchRefspec: `${value}:refs/action/base`,
    };
  }

  const localRef = `refs/remotes/${remote}/${value}`;
  return {
    input: value,
    localRef,
    fetchRefspec: `refs/heads/${value}:${localRef}`,
  };
}

async function assertGitRef(ref: string, label: string): Promise<void> {
  try {
    await execFileAsync("git", ["check-ref-format", ref], { maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(`${label} is not a valid git ref: ${ref}`);
  }
}

function assertShaInput(value: string): void {
  if (value && !isSha(value)) {
    throw new Error("sha must be a full 40-character hex commit SHA");
  }
}

async function git(repositoryPath: string, args: string[]): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repositoryPath,
      maxBuffer: 1024 * 1024,
    });
    if (stdout.trim()) {
      core.debug(stdout.trim());
    }
    if (stderr.trim()) {
      core.debug(stderr.trim());
    }
  } catch (error) {
    if (isExecError(error)) {
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(output || error.message);
    }
    throw error;
  }
}

async function gitStdout(repositoryPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryPath,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (isExecError(error)) {
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(output || error.message);
    }
    throw error;
  }
}

function setOutputs(result: VerificationResult): void {
  core.setOutput("tag", result.tag);
  core.setOutput("sha", result.sha);
  core.setOutput("tag-sha", result.tagSha);
  core.setOutput("head-sha", result.headSha);
  core.setOutput("base-ref", result.baseRef);
  core.setOutput("base-sha", result.baseSha);
  core.setOutput("repository-path", result.repositoryPath);
}

async function writeSummary(result: VerificationResult): Promise<void> {
  core.summary.addHeading("Tag ref verified", 2).addTable([
    [
      { data: "Item", header: true },
      { data: "Value", header: true },
    ],
    ["Tag", code(result.tag)],
    ["Release SHA", code(result.sha)],
    ["Tag SHA", code(result.tagSha)],
    ["HEAD SHA", code(result.headSha)],
    ["Base ref", code(result.baseRef)],
    ["Base SHA", code(result.baseSha || "(not checked)")],
    ["Repository path", code(result.repositoryPath)],
  ]);
  await core.summary.write();
}

function getBooleanInput(name: string): boolean {
  const value = core.getInput(name).toLowerCase();
  if (!value) {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    source += character === "*" ? ".*" : character === "?" ? "." : escapeRegExp(character);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSha(value: string): boolean {
  return /^[a-fA-F0-9]{40}$/.test(value);
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error;
}

await run();
