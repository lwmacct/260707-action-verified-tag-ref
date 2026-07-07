import { s as setFailed, g as getInput, i as info, a as setOutput, b as summary, d as debug } from './chunks/actions-shared.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as require$$2 from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import 'path';
import 'os';
import 'crypto';
import 'fs';
import 'http';
import 'https';
import './chunks/vendor.js';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'node:assert';
import 'node:net';
import 'node:stream';
import 'node:buffer';
import 'node:querystring';
import 'node:events';
import 'node:diagnostics_channel';
import 'node:tls';
import 'node:zlib';
import 'node:perf_hooks';
import 'node:util/types';
import 'node:worker_threads';
import 'node:url';
import 'node:async_hooks';
import 'node:console';
import 'node:dns';
import 'string_decoder';
import 'child_process';
import 'timers';

const execFileAsync = promisify(execFile);
async function run() {
    try {
        const inputs = await getInputs();
        const result = await verifyTagRef(inputs);
        setOutputs(result);
        if (inputs.summary) {
            await writeSummary(result);
        }
    }
    catch (error) {
        setFailed(error instanceof Error ? error.message : "Unexpected failure");
    }
}
async function getInputs() {
    const sourceRepository = getInput("source-repository") || getRequiredEnv("GITHUB_REPOSITORY");
    assertRepository(sourceRepository, "source-repository");
    const contextTag = tagFromGithubContext();
    const explicitSourceTag = getInput("source-tag");
    const sourceTag = explicitSourceTag || contextTag;
    const sourceSha = getInput("source-sha").trim() || (explicitSourceTag ? "" : shaFromGithubContext(contextTag));
    if (!sourceTag && getBooleanInput("require-tag")) {
        throw new Error("source-tag is required. Provide source-tag or run from a tag push event.");
    }
    if (sourceSha) {
        assertSha(sourceSha, "source-sha");
    }
    const sourceBaseRef = getInput("source-base-ref") || (await defaultSourceBaseRef(sourceRepository, getInput("token")));
    return {
        sourceRepository,
        sourceTag,
        sourceSha,
        sourceBaseRef,
        sourcePath: getInput("source-path"),
        checkoutPath: getInput("checkout-path"),
        token: getInput("token"),
        fetch: getBooleanInput("fetch"),
        validateReachable: getBooleanInput("validate-reachable"),
        requireTag: getBooleanInput("require-tag"),
        tagPattern: getInput("tag-pattern"),
        summary: getBooleanInput("summary"),
    };
}
async function verifyTagRef(inputs) {
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
    info(`Verified ${inputs.sourceRepository} ${inputs.sourceTag} at ${sourceSha}`);
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
async function prepareRemoteSource(inputs) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "verified-tag-ref-"));
    await git(directory, ["init", "--quiet"]);
    await fetchRemoteSource(directory, inputs, resolveBaseRef(inputs.sourceBaseRef));
    return directory;
}
async function fetchRemoteSource(directory, inputs, baseRef) {
    const remoteUrl = repositoryGitUrl(inputs.sourceRepository);
    const fetchArgs = ["fetch", "--force", "--no-tags", remoteUrl, `refs/tags/${inputs.sourceTag}:refs/tags/${inputs.sourceTag}`];
    if (inputs.validateReachable && baseRef.fetchRefspec) {
        fetchArgs.push(baseRef.fetchRefspec);
    }
    info(`Fetching ${inputs.sourceRepository} tag ${inputs.sourceTag}`);
    await git(directory, fetchArgs, inputs.token);
}
async function fetchLocalSource(directory, inputs, baseRef) {
    const remoteUrl = repositoryGitUrl(inputs.sourceRepository);
    const fetchArgs = ["fetch", "--force", "--no-tags", remoteUrl, `refs/tags/${inputs.sourceTag}:refs/tags/${inputs.sourceTag}`];
    if (inputs.validateReachable && baseRef.fetchRefspec) {
        fetchArgs.push(baseRef.fetchRefspec);
    }
    await git(directory, fetchArgs, inputs.token);
}
async function verifyCheckout(checkoutPath, sourceSha) {
    const checkoutSha = await gitStdout(path.resolve(checkoutPath), ["rev-parse", "HEAD"]);
    if (checkoutSha !== sourceSha) {
        throw new Error(`Checked out ${checkoutSha}, not ${sourceSha}`);
    }
    return checkoutSha;
}
async function assertAncestor(directory, sourceSha, baseRef, sourceTag) {
    try {
        await git(directory, ["merge-base", "--is-ancestor", sourceSha, baseRef]);
    }
    catch {
        throw new Error(`${sourceTag} commit ${sourceSha} is not reachable from ${baseRef}`);
    }
}
function resolveBaseRef(value) {
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
async function defaultSourceBaseRef(sourceRepository, token) {
    const eventDefaultBranch = defaultBranchFromEvent();
    if (sourceRepository === process.env.GITHUB_REPOSITORY && eventDefaultBranch) {
        return eventDefaultBranch;
    }
    try {
        const repository = await githubJson(token, `/repos/${sourceRepository}`);
        if (repository.default_branch) {
            return repository.default_branch;
        }
    }
    catch (error) {
        debug(`Failed to resolve default branch from GitHub API: ${error instanceof Error ? error.message : String(error)}`);
    }
    return eventDefaultBranch || "main";
}
async function githubJson(token, pathname) {
    if (!token) {
        throw new Error("token is required to resolve source repository metadata");
    }
    const response = await requestText(`${githubApiBaseUrl()}${pathname}`, {
        method: "GET",
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            connection: "close",
            "x-github-api-version": "2022-11-28",
        },
    });
    if (response.statusCode < 200 || response.statusCode > 299) {
        throw new Error(`GitHub API request failed: ${response.statusCode} ${response.statusMessage}${response.body ? `\n${response.body}` : ""}`);
    }
    return JSON.parse(response.body);
}
function requestText(url, options) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === "http:" ? require$$2 : https;
        const request = client.request(parsedUrl, {
            method: options.method,
            headers: options.headers,
            agent: false,
        }, (response) => {
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
        });
        request.on("error", reject);
        request.end();
    });
}
async function assertGitRef(ref, label) {
    try {
        await execFileAsync("git", ["check-ref-format", ref], { maxBuffer: 1024 * 1024 });
    }
    catch {
        throw new Error(`${label} is not a valid git ref: ${ref}`);
    }
}
async function git(directory, args, token = "") {
    try {
        const finalArgs = token ? ["-c", `http.${githubServerUrl()}/.extraheader=AUTHORIZATION: bearer ${token}`, ...args] : args;
        const { stdout, stderr } = await execFileAsync("git", finalArgs, {
            cwd: directory,
            maxBuffer: 1024 * 1024,
        });
        if (stdout.trim()) {
            debug(stdout.trim());
        }
        if (stderr.trim()) {
            debug(stderr.trim());
        }
    }
    catch (error) {
        if (isExecError(error)) {
            const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
            throw new Error(output || error.message);
        }
        throw error;
    }
}
async function gitStdout(directory, args) {
    try {
        const { stdout } = await execFileAsync("git", args, {
            cwd: directory,
            maxBuffer: 1024 * 1024,
        });
        return stdout.trim();
    }
    catch (error) {
        if (isExecError(error)) {
            const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
            throw new Error(output || error.message);
        }
        throw error;
    }
}
function setOutputs(result) {
    setOutput("source-repository", result.sourceRepository);
    setOutput("source-tag", result.sourceTag);
    setOutput("source-sha", result.sourceSha);
    setOutput("sha", result.sourceSha);
    setOutput("tag-sha", result.tagSha);
    setOutput("base-ref", result.baseRef);
    setOutput("base-sha", result.baseSha);
    setOutput("checkout-sha", result.checkoutSha);
    setOutput("source-path", result.sourcePath);
}
async function writeSummary(result) {
    summary.addHeading("Tag ref verified", 2).addTable([
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
    await summary.write();
}
function tagFromGithubContext() {
    if (process.env.GITHUB_REF_TYPE === "tag") {
        return process.env.GITHUB_REF_NAME ?? "";
    }
    const ref = process.env.GITHUB_REF ?? "";
    return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
}
function shaFromGithubContext(tag) {
    return tag ? (process.env.GITHUB_SHA ?? "") : "";
}
function defaultBranchFromEvent() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        return "";
    }
    try {
        const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
        const defaultBranch = payload.repository?.default_branch;
        return typeof defaultBranch === "string" ? defaultBranch : "";
    }
    catch (error) {
        debug(`Failed to read default branch from event payload: ${error instanceof Error ? error.message : String(error)}`);
        return "";
    }
}
function getBooleanInput(name) {
    const value = getInput(name).toLowerCase();
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
function assertRepository(repository, name) {
    const [owner, repo, extra] = repository.split("/");
    if (!owner || !repo || extra) {
        throw new Error(`${name} must use owner/repo format`);
    }
}
function assertSha(value, name) {
    if (!isSha(value)) {
        throw new Error(`${name} must be a full 40-character hex commit SHA`);
    }
}
function matchesGlob(value, pattern) {
    return globToRegExp(pattern).test(value);
}
function globToRegExp(pattern) {
    let source = "^";
    for (const character of pattern) {
        if (character === "*") {
            source += ".*";
        }
        else if (character === "?") {
            source += ".";
        }
        else {
            source += escapeRegExp(character);
        }
    }
    source += "$";
    return new RegExp(source);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isSha(value) {
    return /^[a-fA-F0-9]{40}$/.test(value);
}
function repositoryGitUrl(repository) {
    return `${githubServerUrl()}/${repository}.git`;
}
function githubServerUrl() {
    return process.env.GITHUB_SERVER_URL || "https://github.com";
}
function githubApiBaseUrl() {
    return process.env.GITHUB_API_URL || "https://api.github.com";
}
function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}
function code(value) {
    return `\`${value.replaceAll("`", "\\`")}\``;
}
function isExecError(error) {
    return error instanceof Error;
}
await run();
