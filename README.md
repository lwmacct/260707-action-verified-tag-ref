# Verify Tag Ref

在已 checkout 的 git 仓库里验证发布 tag，输出可信 commit SHA。

这个 Action 不负责 clone 仓库。请先用 `actions/checkout` 把要发布的 commit checkout 到工作区。

## 基本用法

```yaml
- uses: actions/checkout@v5
  with:
    ref: ${{ inputs.source-sha || inputs.source-tag }}
    fetch-depth: 0

- id: release-ref
  uses: lwmacct/260707-action-verified-tag-ref@main
  with:
    tag: ${{ inputs.source-tag }}
    sha: ${{ inputs.source-sha }}
```

Action 会验证：

- tag 存在并解析到 commit
- 如果传入 `sha`，tag commit 必须等于该 sha
- 当前 checkout `HEAD` 必须等于 release sha
- release sha 必须可从 `base-ref` 到达，默认 `main`

## 跨仓库

跨仓库发布时也先交给 `actions/checkout`：

```yaml
- uses: actions/checkout@v5
  with:
    repository: owner/repo
    ref: ${{ inputs.source-sha || inputs.source-tag }}
    fetch-depth: 0
    token: ${{ secrets.SOURCE_TOKEN }}

- id: release-ref
  uses: lwmacct/260707-action-verified-tag-ref@main
  with:
    tag: ${{ inputs.source-tag }}
    sha: ${{ inputs.source-sha }}
    base-ref: main
```

## Inputs

| 名称 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `tag` | 是 |  | 要验证的 release tag |
| `sha` | 否 | tag 指向的 commit | 可选预期 commit SHA，必须是完整 40 位 hex |
| `base-ref` | 否 | `main` | release commit 必须可到达的 ref |
| `repository-path` | 否 | `.` | 已 checkout 的 git 仓库路径 |
| `remote` | 否 | `origin` | fetch tag 和 base-ref 使用的 git remote |
| `fetch` | 否 | `true` | 是否在验证前 fetch tag 和 base-ref |
| `validate-checkout` | 否 | `true` | 是否要求 `HEAD` 等于 release sha |
| `validate-reachable` | 否 | `true` | 是否要求 release sha 可从 `base-ref` 到达 |
| `tag-pattern` | 否 |  | 可选 tag glob，例如 `v*` |
| `summary` | 否 | `true` | 是否写入 GitHub Step Summary |

## Outputs

| 名称 | 说明 |
| --- | --- |
| `tag` | 已验证 tag |
| `sha` | 最终可信 release commit SHA |
| `tag-sha` | tag 解析出的 commit SHA |
| `head-sha` | checkout HEAD SHA |
| `base-ref` | reachability 校验使用的本地 base ref |
| `base-sha` | base ref 对应 commit SHA |
| `repository-path` | 验证的仓库路径 |
