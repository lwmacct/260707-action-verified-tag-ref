import { s as setFailed, g as getInput, i as info, a as setOutput, b as summary, d as debug } from './chunks/actions-shared.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
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
import 'node:http';
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
        const inputs = getInputs();
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
function getInputs() {
    const tag = getInput("tag", { required: true });
    const baseRef = getInput("base-ref") || defaultBranchFromEvent() || "main";
    const remote = getInput("remote") || "origin";
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
        tag,
        sha: getInput("sha").trim(),
        baseRef,
        remote,
        fetch: getBooleanInput("fetch"),
        validateCheckout: getBooleanInput("validate-checkout"),
        validateReachable: getBooleanInput("validate-reachable"),
        tagPattern: getInput("tag-pattern"),
        summary: getBooleanInput("summary"),
    };
}
async function verifyTagRef(inputs) {
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
        await fetchTag(inputs.remote, inputs.tag);
        if (inputs.validateReachable && baseRef.fetchRefspec) {
            await fetchBaseRef(inputs.remote, baseRef);
        }
    }
    const tagSha = await gitStdout(["rev-parse", `refs/tags/${inputs.tag}^{commit}`]);
    const releaseSha = inputs.sha || tagSha;
    if (tagSha !== releaseSha) {
        throw new Error(`${inputs.tag} points to ${tagSha}, not ${releaseSha}`);
    }
    const headSha = await gitStdout(["rev-parse", "HEAD"]);
    if (inputs.validateCheckout && headSha !== releaseSha) {
        throw new Error(`Checked out ${headSha}, not ${releaseSha}`);
    }
    let baseSha = "";
    if (inputs.validateReachable) {
        baseSha = await gitStdout(["rev-parse", `${baseRef.localRef}^{commit}`]);
        await assertAncestor(releaseSha, baseRef.localRef, inputs.tag);
    }
    info(`Verified ${inputs.tag} at ${releaseSha}`);
    return {
        tag: inputs.tag,
        sha: releaseSha,
        tagSha,
        headSha,
        baseRef: baseRef.localRef,
        baseSha,
    };
}
async function fetchTag(remote, tag) {
    info(`Fetching tag ${tag} from ${remote}`);
    await git(["fetch", "--force", remote, `refs/tags/${tag}:refs/tags/${tag}`]);
}
async function fetchBaseRef(remote, baseRef) {
    info(`Fetching base ref ${baseRef.input} from ${remote}`);
    await git(["fetch", "--force", remote, baseRef.fetchRefspec]);
}
async function assertAncestor(releaseSha, baseRef, tag) {
    try {
        await git(["merge-base", "--is-ancestor", releaseSha, baseRef]);
    }
    catch {
        throw new Error(`${tag} commit ${releaseSha} is not reachable from ${baseRef}`);
    }
}
function resolveBaseRef(value, remote) {
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
            localRef: value,
            fetchRefspec: `${value}:${value}`,
        };
    }
    const localRef = `refs/remotes/${remote}/${value}`;
    return {
        input: value,
        localRef,
        fetchRefspec: `refs/heads/${value}:${localRef}`,
    };
}
async function assertGitRef(ref, label) {
    try {
        await git(["check-ref-format", ref]);
    }
    catch {
        throw new Error(`${label} is not a valid git ref: ${ref}`);
    }
}
function assertShaInput(value) {
    if (value && !isSha(value)) {
        throw new Error("sha must be a full 40-character hex commit SHA");
    }
}
async function git(args) {
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
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
async function gitStdout(args) {
    try {
        const { stdout } = await execFileAsync("git", args, {
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
    setOutput("tag", result.tag);
    setOutput("sha", result.sha);
    setOutput("tag-sha", result.tagSha);
    setOutput("head-sha", result.headSha);
    setOutput("base-ref", result.baseRef);
    setOutput("base-sha", result.baseSha);
}
async function writeSummary(result) {
    summary.addHeading("Tag ref verified", 2).addTable([
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
    ]);
    await summary.write();
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
function code(value) {
    return `\`${value.replaceAll("`", "\\`")}\``;
}
function isExecError(error) {
    return error instanceof Error;
}
await run();
