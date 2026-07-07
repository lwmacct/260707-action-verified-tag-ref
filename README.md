# Verify Tag Ref

验证 source 仓库的发布 tag，输出可信 commit SHA。默认不依赖提前 checkout，而是直接 fetch `source-repository` 的 tag 和 base ref；这让它可以放在中心发布仓库里验证其他项目。

## 最小用法

如果 workflow 是 tag push 触发，且 source 仓库就是当前仓库：

```yaml
- id: release-ref
  uses: lwmacct/260707-action-verified-tag-ref@main
```

Action 会自动推断：

- `source-repository`: 当前仓库
- `source-tag`: 当前 tag ref
- `source-sha`: tag push 事件的 `GITHUB_SHA`
- `source-base-ref`: source 仓库默认分支

## workflow_dispatch 用法

搭配 `action-workflow-dispatch` 时，目标 workflow 通常接收标准 inputs：

```yaml
on:
  workflow_dispatch:
    inputs:
      source-repository:
        required: true
        type: string
      source-tag:
        required: true
        type: string
      source-sha:
        required: false
        type: string
      source-base-ref:
        required: false
        type: string
```

验证并 checkout source commit：

```yaml
- id: release-ref
  uses: lwmacct/260707-action-verified-tag-ref@main
  with:
    source-repository: ${{ inputs.source-repository }}
    source-tag: ${{ inputs.source-tag }}
    source-sha: ${{ inputs.source-sha }}
    source-base-ref: ${{ inputs.source-base-ref }}

- uses: actions/checkout@v5
  with:
    repository: ${{ steps.release-ref.outputs.source-repository }}
    ref: ${{ steps.release-ref.outputs.sha }}
```

## 本地 checkout 额外校验

如果已经 checkout 了 source commit，可以加 `checkout-path`，要求该目录的 `HEAD` 必须等于验证出的 source SHA：

```yaml
- uses: actions/checkout@v5
  with:
    ref: ${{ inputs.source-sha || inputs.source-tag }}
    fetch-depth: 0

- id: release-ref
  uses: lwmacct/260707-action-verified-tag-ref@main
  with:
    source-tag: ${{ inputs.source-tag }}
    source-sha: ${{ inputs.source-sha }}
    checkout-path: .
```

## 本地仓库模式

测试或特殊场景可以传 `source-path`，直接使用本地 git 仓库里的 tag/ref：

```yaml
- id: release-ref
  uses: lwmacct/260707-action-verified-tag-ref@main
  with:
    source-path: .
    source-tag: v1.2.3
    source-base-ref: HEAD
    fetch: "false"
```

## Inputs

| 名称 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `source-repository` | 否 | 当前仓库 | source tag 所在仓库 |
| `source-tag` | 否 | 当前 tag ref | 要验证的 release tag |
| `source-sha` | 否 | tag push 的 `GITHUB_SHA` | 可选预期 source commit SHA |
| `source-base-ref` | 否 | source 仓库默认分支 | source commit 必须可到达的 ref |
| `source-path` | 否 |  | 本地 git 仓库路径；为空时使用远程验证模式 |
| `checkout-path` | 否 |  | 可选 checkout 目录，验证其 `HEAD` 等于 source SHA |
| `token` | 否 | `${{ github.token }}` | 读取 source repo metadata 和 fetch 私有仓库使用 |
| `fetch` | 否 | `true` | `source-path` 模式下是否 fetch tag/base；远程模式始终 fetch |
| `validate-reachable` | 否 | `true` | 是否要求 source SHA 可从 `source-base-ref` 到达 |
| `require-tag` | 否 | `true` | 没有 source tag 时是否失败 |
| `tag-pattern` | 否 |  | source tag glob，例如 `v*` |
| `summary` | 否 | `true` | 是否写入 Step Summary |

## Outputs

| 名称 | 说明 |
| --- | --- |
| `source-repository` | source 仓库 |
| `source-tag` | 已验证的 source tag |
| `source-sha` | 最终可信 source commit SHA |
| `sha` | `source-sha` 的别名 |
| `tag-sha` | 从 tag 解析出的 commit SHA |
| `base-ref` | reachability 校验使用的本地 base ref |
| `base-sha` | base ref 对应 commit SHA |
| `checkout-sha` | `checkout-path` 的 HEAD SHA |
| `source-path` | 实际用于 git 验证的本地路径 |
