# Raindrop 收藏同步

手机保存链接 → Raindrop → NotaVoy 收件箱 → 点击“转入…”归档。

本方案同步收藏的链接、摘要与可用摘录。它不会自动读取各平台的收藏列表，也不保证保存视频文件或受登录限制的全文。同步方向为 Raindrop → Obsidian；自动同步期间需要 Obsidian 和插件保持运行。

## 1. 手机端收集

在 Raindrop 新建一个收藏夹，例如“学习收集箱”。从抖音、小红书、B 站、微信公众号或 GitHub 分享链接到 Raindrop，保存到这个收藏夹。

若“添加链接”提示链接无效，先从分享文案中提取完整的 `https://…` 地址，去掉前后的说明、口令和表情，再保存。保留 URL 自带的路径、查询参数和片段。标题识别不完整时，可以在转入工作台的表单里修改名称。

## 2. 连接 Obsidian

1. 在 **设置 → 社区插件** 安装并启用 [Raindrop Highlights](https://github.com/kaiiiz/obsidian-raindrop-highlights-plugin)。本指南按已验证的 **0.0.25** 版本整理；该插件不随 NotaVoy 打包。
2. 打开 Raindrop 的[集成设置](https://app.raindrop.io/settings/integrations)，创建自己的应用，把 **Test token** 填入 Raindrop Highlights 设置并连接。不要把 token 写进笔记或提交到仓库。
3. 在同步收藏夹管理中，只启用自己用于收集的收藏夹；不要同时启用包含相同收藏的“All bookmarks”。
4. 确认 `00-收件箱/Raindrop` 文件夹存在，按下表设置，再填写下一节的三个模板。

| 设置 | 值 |
| --- | --- |
| Folder location | `00-收件箱/Raindrop` |
| Only sync bookmarks with highlights | 关闭；没有高亮的收藏也要导入 |
| Append Mode | 开启；保留正文中的本地笔记 |
| Folder location: Collections folders | 关闭 |
| Folder location: Collection groups | 关闭 |
| Folder location: Prevent moving existing files on sync | 开启 |
| Delete local files when removed from Raindrop | 关闭 |
| 自动同步全部收藏夹、自动启用新增子收藏夹 | 关闭；按需选择收藏夹 |
| Auto sync in interval (minutes) | `10`；设为 `0` 可改为手动同步 |
| 同步成功通知 | 关闭或按需开启 |
| Enable autoescaping for nunjucks | 关闭 |

## 3. 三个同步模板

将代码块里的内容分别复制到插件的文件名、属性和正文模板设置中，不要复制最外层的代码围栏。属性值使用 `dump` 转为合法 YAML，避免标题、链接或备注中的符号破坏属性。

### 文件名模板（Filename template）

```nunjucks
{% if title %}{{title}}{% else %}收藏-{{id}}{% endif %}
```

### 属性模板（Metadata template）

不需要添加 YAML 开头和结尾的 `---`。

```nunjucks
{% if is_new_article %}类型: 收藏
整理状态: 待整理
归档笔记: []
{% endif %}来源: {{ link | dump | safe }}
收藏时间: {{ created | date("YYYY-MM-DDTHH:mm:ssZ") | dump | safe }}
收藏夹: {{ collection.title | dump | safe }}
摘要: {{ excerpt | dump | safe }}
收藏备注: {{ note | dump | safe }}
tags: {{ tags | dump | safe }}
```

### 正文模板（Content template）

````nunjucks
{%- if is_new_article -%}
```inbox-actions
```

## 我的笔记

## 摘录
{%- endif -%}
{%- for highlight in highlights %}

> [!quote] {{ highlight.created | date("YYYY-MM-DD") }}
> {{ highlight.text.split("\n") | join("\n> ") | safe }}
{% if highlight.note %}> {{ highlight.note.split("\n") | join("\n> ") | safe }}
{% endif %}
{%- endfor -%}
````

“整理状态”“归档笔记”和按钮只在首次导入时写入，后续同步继续更新来源元数据并追加新摘录。原始收藏的 `raindrop_id` 和 `raindrop_highlights` 由同步插件维护，请保留。

## 4. 同步与转入

1. 首次运行命令 **Raindrop Highlights: Sync all bookmarks (full sync)**，以后使用增量同步或等待自动同步。
2. 打开 **首页 → 收件箱**，全部收藏会显示在表格中；点击名称在右侧打开。
3. 点击 **转入…**，确认名称和来源，选择兴趣项目、未读论文、课程与播客、随手想法，或选择一个已有项目。
4. 转入后，原始收藏标记为“已整理”，并通过“归档笔记”链接到结果；仍保留在收件箱中。

选择分类条目会保留来源、收藏备注及已有笔记；选择已有项目会写入“参考链接与课程”。重复转入同名、同来源的条目会复用笔记，项目中的相同链接也不会重复追加。其他同名冲突会提示修改名称。转入后两份正文各自维护，后续同步到收件箱的新内容不会自动合并到归档笔记。

## 5. 升级已有 NotaVoy 库

保留自己的笔记和插件 `data.json`，从新版复制这些文件：

- `.obsidian/plugins/project-tasks/main.js`、`manifest.json`、`styles.css`
- `99-系统/数据库/收藏收件箱.base`
- `99-系统/数据库/课程与播客.base`：修复清空“类型”后记录消失的问题；已有自定义列和排序时，只需将顶层“类型”过滤替换为 `file.ext == "md"`。

如果收件箱已有正文，在其中加入下列嵌入即可：

```markdown
## 收藏收件箱

![[99-系统/数据库/收藏收件箱.base#全部收藏]]
```

重新加载“项目与任务”插件，再配置本指南中的同步模板。已有收藏不会因修改模板自动补上首次导入内容；可直接运行命令 **项目与任务：转入当前收藏**，或在收藏正文添加：

````markdown
```inbox-actions
```
````

原始收藏放在 `00-收件箱/Raindrop` 下即可使用转换。无需删除后重新同步，也无需预先补齐“类型”“整理状态”或“归档笔记”；成功转换时会写入整理结果。

同步插件、账号配置和个人收藏默认被本仓库的 `.gitignore` 忽略。升级自己维护的 Git 仓库时，也请合并新版对应的忽略规则。
