# Verify Tag Ref

验证一个发布 tag 是否指向预期 commit，并确认当前 checkout 与发布 commit 一致、发布 commit 可从指定 base ref 到达。

这个 Action 适合放在真正执行发布的 workflow 中，例如：

```text
publish workflow on main/default branch
  -> checkout release commit
  -> verify tag + optional sha + checkout HEAD + base reachability
  -> build and publish
```

它不负责创建 tag、checkout、构建、镜像发布或部署，只负责把发布对象校验成一个可信的 commit SHA。

## 基本用法

```yaml
jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      sha: ${{ steps.release-ref.outputs.sha }}
    permissions:
      contents: read
    steps:
      - name: Checkout release commit
        uses: actions/checkout@v5
        with:
          ref: ${{ inputs.sha || inputs.tag }}
          fetch-depth: 0

      - name: Verify release tag ref
        id: release-ref
        uses: lwmacct/260707-action-verified-tag-ref@main
        with:
          tag: ${{ inputs.tag }}
          sha: ${{ inputs.sha }}
          base-ref: main
          tag-pattern: "v*"
```

后续 job 可以使用：

```yaml
needs.prepare.outputs.sha
```

## 校验内容

默认会执行：

- fetch 指定 tag
- fetch `base-ref`
- 解析 `refs/tags/<tag>^{commit}`，兼容 lightweight tag 和 annotated tag
- 如果传入 `sha`，要求 tag commit 等于该 sha
- 要求当前 checkout `HEAD` 等于最终 release sha
- 要求 release sha 可从 `base-ref` 到达

## Inputs

| 名称 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `tag` | 是 |  | 要验证的 release tag |
| `sha` | 否 | tag 指向的 commit | 可选预期 commit SHA，必须是完整 40 位 hex |
| `base-ref` | 否 | 仓库默认分支，取不到时为 `main` | 发布 commit 必须可到达的分支或 ref |
| `remote` | 否 | `origin` | fetch tag 和 base ref 使用的 git remote |
| `fetch` | 否 | `true` | 是否在验证前 fetch tag 和 base ref |
| `validate-checkout` | 否 | `true` | 是否要求当前 checkout `HEAD` 等于 release sha |
| `validate-reachable` | 否 | `true` | 是否要求 release sha 可从 `base-ref` 到达 |
| `tag-pattern` | 否 |  | 可选 tag glob，例如 `v*` |
| `summary` | 否 | `true` | 是否写入 GitHub Step Summary |

## Outputs

| 名称 | 说明 |
| --- | --- |
| `tag` | 已验证的 tag |
| `sha` | 最终可信的 release commit SHA |
| `tag-sha` | 从 tag 解析出的 commit SHA |
| `head-sha` | 当前 checkout HEAD SHA |
| `base-ref` | 用于 reachability 校验的本地 base ref |
| `base-sha` | 从 base ref 解析出的 commit SHA |

## 和 workflow-dispatch 配合

入口 workflow 可以用 `action-workflow-dispatch` 把 tag 事件转发到主分支上的 `publish.yml`：

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    ref: main
    tag-pattern: "v*"
```

发布 workflow 再用本 Action 校验实际发布对象：

```yaml
- uses: lwmacct/260707-action-verified-tag-ref@main
  id: release-ref
  with:
    tag: ${{ inputs.tag }}
    sha: ${{ inputs.sha }}
    base-ref: main
```
