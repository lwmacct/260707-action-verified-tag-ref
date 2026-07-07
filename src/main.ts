import * as core from "@actions/core";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Inputs {
  sourceRepository: string;
  sourceTag: string;
  sourceSha: string;
  sourceBaseRef: string;
  sourcePath: string;
  checkoutPath: string;
  token: string;
  fetch: boolean;
  validateReachable: boolean;
  requireTag: boolean;
  tagPattern: string;
  summary: boolean;
}

interface VerificationResult {
  sourceRepository: string;
  sourceTag: string;
  sourceSha: string;
  tagSha: string;
  baseRef: string;
  baseSha: string;
  checkoutSha: string;
  sourcePath: string;
}

interface GitHubEventPayload {
  repository?: {
    default_branch?: unknown;
  };
}

interface RepositoryResponse {
  default_branch?: string;
}

interface BaseRef {
  input: string;
  localRef: string;
  fetchRefspec: string;
}

async function run(): Promise<void> {
  try {
    const inputs = await getInputs();
    const result = await verifyTagRef(inputs);
    setOutputs(result);
    if (inputs.summary) {
      await writeSummary(result);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Unexpected failure");
  }
}

async function getInputs(): Promise<Inputs> {
  const sourceRepository = core.getInput("source-repository") || getRequiredEnv("GITHUB_REPOSITORY");
  assertRepository(sourceRepository, "source-repository");

  const contextTag = tagFromGithubContext();
  const explicitSourceTag = core.getInput("source-tag");
  const sourceTag = explicitSourceTag || contextTag;
  const sourceSha = core.getInput("source-sha").trim() || (explicitSourceTag ? "" : shaFromGithubContext(contextTag));

  if (!sourceTag && getBooleanInput("require-tag")) {
    throw new Error("source-tag is required. Provide source-tag or run from a tag push event.");
  }
  if (sourceSha) {
    assertSha(sourceSha, "source-sha");
  }

  const sourceBaseRef = core.getInput("source-base-ref") || (await defaultSourceBaseRef(sourceRepository, core.getInput("token")));

  return {
    sourceRepository,
    sourceTag,
    sourceSha,
    sourceBaseRef,
    sourcePath: core.getInput("source-path"),
    checkoutPath: core.getInput("checkout-path"),
    token: core.getInput("token"),
    fetch: getBooleanInput("fetch"),
    validateReachable: getBooleanInput("validate-reachable"),
    requireTag: getBooleanInput("require-tag"),
    tagPattern: core.getInput("tag-pattern"),
    summary: getBooleanInput("summary"),
  };
}

async function verifyTagRef(inputs: Inputs): Promise<VerificationResult> {
  if (!inputs.sourceTag) {
    throw new Error("source-tag is required");
  }
  if (inputs.tagPattern && !matchesGlob(inputs.sourceTag, inputs.tagPattern)) {
    throw new Error(`source-tag ${inputs.sourceTag} does not match pattern ${inputs.tagPattern}`);
  }

  await assertGitRef(`refs/tags/${inputs.sourceTag}`, "source-tag");
  const sourcePath = inputs.sourcePath ? path.resolve(inputs.sourcePath) : await prepareRemoteSource(inputs);
  const baseRef = resolveBaseRef(inputs.sourceBaseRef);

  if (inputs.sourcePath && inputs.fetch) {
    await fetchLocalSource(sourcePath, inputs, baseRef);
  }

  const tagSha = await gitStdout(sourcePath, ["rev-parse", `refs/tags/${inputs.sourceTag}^{commit}`]);
  const sourceSha = inputs.sourceSha || tagSha;
  if (tagSha !== sourceSha) {
    throw new Error(`${inputs.sourceTag} points to ${tagSha}, not ${sourceSha}`);
  }

  let baseSha = "";
  if (inputs.validateReachable) {
    baseSha = await gitStdout(sourcePath, ["rev-parse", `${baseRef.localRef}^{commit}`]);
    await assertAncestor(sourcePath, sourceSha, baseRef.localRef, inputs.sourceTag);
  }

  const checkoutSha = inputs.checkoutPath ? await verifyCheckout(inputs.checkoutPath, sourceSha) : "";

  core.info(`Verified ${inputs.sourceRepository} ${inputs.sourceTag} at ${sourceSha}`);
  return {
    sourceRepository: inputs.sourceRepository,
    sourceTag: inputs.sourceTag,
    sourceSha,
    tagSha,
    baseRef: baseRef.localRef,
    baseSha,
    checkoutSha,
    sourcePath,
  };
}

async function prepareRemoteSource(inputs: Inputs): Promise<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "verified-tag-ref-"));
  await git(directory, ["init", "--quiet"]);
  await fetchRemoteSource(directory, inputs, resolveBaseRef(inputs.sourceBaseRef));
  return directory;
}

async function fetchRemoteSource(directory: string, inputs: Inputs, baseRef: BaseRef): Promise<void> {
  const remoteUrl = repositoryGitUrl(inputs.sourceRepository);
  const fetchArgs = ["fetch", "--force", "--no-tags", remoteUrl, `refs/tags/${inputs.sourceTag}:refs/tags/${inputs.sourceTag}`];
  if (inputs.validateReachable && baseRef.fetchRefspec) {
    fetchArgs.push(baseRef.fetchRefspec);
  }
  core.info(`Fetching ${inputs.sourceRepository} tag ${inputs.sourceTag}`);
  await git(directory, fetchArgs, inputs.token);
}

async function fetchLocalSource(directory: string, inputs: Inputs, baseRef: BaseRef): Promise<void> {
  const remoteUrl = repositoryGitUrl(inputs.sourceRepository);
  const fetchArgs = ["fetch", "--force", "--no-tags", remoteUrl, `refs/tags/${inputs.sourceTag}:refs/tags/${inputs.sourceTag}`];
  if (inputs.validateReachable && baseRef.fetchRefspec) {
    fetchArgs.push(baseRef.fetchRefspec);
  }
  await git(directory, fetchArgs, inputs.token);
}

async function verifyCheckout(checkoutPath: string, sourceSha: string): Promise<string> {
  const checkoutSha = await gitStdout(path.resolve(checkoutPath), ["rev-parse", "HEAD"]);
  if (checkoutSha !== sourceSha) {
    throw new Error(`Checked out ${checkoutSha}, not ${sourceSha}`);
  }
  return checkoutSha;
}

async function assertAncestor(directory: string, sourceSha: string, baseRef: string, sourceTag: string): Promise<void> {
  try {
    await git(directory, ["merge-base", "--is-ancestor", sourceSha, baseRef]);
  } catch {
    throw new Error(`${sourceTag} commit ${sourceSha} is not reachable from ${baseRef}`);
  }
}

function resolveBaseRef(value: string): BaseRef {
  const baseRef = value || "main";
  if (baseRef === "HEAD" || isSha(baseRef)) {
    return { input: baseRef, localRef: baseRef, fetchRefspec: "" };
  }

  if (baseRef.startsWith("refs/heads/")) {
    const branch = baseRef.slice("refs/heads/".length);
    return {
      input: baseRef,
      localRef: `refs/remotes/source/${branch}`,
      fetchRefspec: `${baseRef}:refs/remotes/source/${branch}`,
    };
  }

  if (baseRef.startsWith("refs/remotes/")) {
    return { input: baseRef, localRef: baseRef, fetchRefspec: "" };
  }

  if (baseRef.startsWith("source/")) {
    const branch = baseRef.slice("source/".length);
    return {
      input: baseRef,
      localRef: `refs/remotes/source/${branch}`,
      fetchRefspec: `refs/heads/${branch}:refs/remotes/source/${branch}`,
    };
  }

  if (baseRef.startsWith("refs/")) {
    return {
      input: baseRef,
      localRef: "refs/action/source-base",
      fetchRefspec: `${baseRef}:refs/action/source-base`,
    };
  }

  return {
    input: baseRef,
    localRef: `refs/remotes/source/${baseRef}`,
    fetchRefspec: `refs/heads/${baseRef}:refs/remotes/source/${baseRef}`,
  };
}

async function defaultSourceBaseRef(sourceRepository: string, token: string): Promise<string> {
  const eventDefaultBranch = defaultBranchFromEvent();
  if (sourceRepository === process.env.GITHUB_REPOSITORY && eventDefaultBranch) {
    return eventDefaultBranch;
  }

  try {
    const repository = await githubJson<RepositoryResponse>(token, `/repos/${sourceRepository}`);
    if (repository.default_branch) {
      return repository.default_branch;
    }
  } catch (error) {
    core.debug(`Failed to resolve default branch from GitHub API: ${error instanceof Error ? error.message : String(error)}`);
  }

  return eventDefaultBranch || "main";
}

async function githubJson<T>(token: string, pathname: string): Promise<T> {
  if (!token) {
    throw new Error("token is required to resolve source repository metadata");
  }

  const response = await requestText(`${githubApiBaseUrl()}${pathname}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      connection: "close",
      "user-agent": "lwmacct/260707-action-verified-tag-ref",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (response.statusCode < 200 || response.statusCode > 299) {
    throw new Error(`GitHub API request failed: ${response.statusCode} ${response.statusMessage}${response.body ? `\n${response.body}` : ""}`);
  }

  return JSON.parse(response.body) as T;
}

function requestText(
  url: string,
  options: { method: string; headers: Record<string, string> },
): Promise<{ statusCode: number; statusMessage: string; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "http:" ? http : https;
    const request = client.request(
      parsedUrl,
      {
        method: options.method,
        headers: options.headers,
        agent: false,
      },
      (response) => {
        response.setEncoding("utf8");
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          response.socket.destroy();
          resolve({
            statusCode: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? "",
            body: responseBody,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function assertGitRef(ref: string, label: string): Promise<void> {
  try {
    await execFileAsync("git", ["check-ref-format", ref], { maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(`${label} is not a valid git ref: ${ref}`);
  }
}

async function git(directory: string, args: string[], token = ""): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: directory,
      env: gitEnv(token),
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

function gitEnv(token: string): NodeJS.ProcessEnv {
  if (!token) {
    return process.env;
  }

  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${githubServerUrl()}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuthToken(token)}`,
  };
}

function basicAuthToken(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

async function gitStdout(directory: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: directory,
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
  core.setOutput("source-repository", result.sourceRepository);
  core.setOutput("source-tag", result.sourceTag);
  core.setOutput("source-sha", result.sourceSha);
  core.setOutput("sha", result.sourceSha);
  core.setOutput("tag-sha", result.tagSha);
  core.setOutput("base-ref", result.baseRef);
  core.setOutput("base-sha", result.baseSha);
  core.setOutput("checkout-sha", result.checkoutSha);
  core.setOutput("source-path", result.sourcePath);
}

async function writeSummary(result: VerificationResult): Promise<void> {
  core.summary.addHeading("Tag ref verified", 2).addTable([
    [
      { data: "Item", header: true },
      { data: "Value", header: true },
    ],
    ["Source repository", code(result.sourceRepository)],
    ["Source tag", code(result.sourceTag)],
    ["Source SHA", code(result.sourceSha)],
    ["Tag SHA", code(result.tagSha)],
    ["Base ref", code(result.baseRef)],
    ["Base SHA", code(result.baseSha || "(not checked)")],
    ["Checkout SHA", code(result.checkoutSha || "(not checked)")],
  ]);
  await core.summary.write();
}

function tagFromGithubContext(): string {
  if (process.env.GITHUB_REF_TYPE === "tag") {
    return process.env.GITHUB_REF_NAME ?? "";
  }

  const ref = process.env.GITHUB_REF ?? "";
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
}

function shaFromGithubContext(tag: string): string {
  return tag ? (process.env.GITHUB_SHA ?? "") : "";
}

function defaultBranchFromEvent(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return "";
  }

  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8")) as GitHubEventPayload;
    const defaultBranch = payload.repository?.default_branch;
    return typeof defaultBranch === "string" ? defaultBranch : "";
  } catch (error) {
    core.debug(`Failed to read default branch from event payload: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
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

function assertRepository(repository: string, name: string): void {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`${name} must use owner/repo format`);
  }
}

function assertSha(value: string, name: string): void {
  if (!isSha(value)) {
    throw new Error(`${name} must be a full 40-character hex commit SHA`);
  }
}

function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += escapeRegExp(character);
    }
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

function repositoryGitUrl(repository: string): string {
  return `${githubServerUrl()}/${repository}.git`;
}

function githubServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || "https://github.com";
}

function githubApiBaseUrl(): string {
  return process.env.GITHUB_API_URL || "https://api.github.com";
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error;
}

await run();
