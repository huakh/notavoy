const {
  Plugin, PluginSettingTab, Setting, Modal, Notice, BasesView, TFile, Menu, FuzzySuggestModal, MarkdownView,
  parseYaml, stringifyYaml, getFrontMatterInfo, moment
} = require('obsidian');

const VIEW = 'project-task-table';
const DEFAULTS = {
  domains: ['学业', '工作', '生活', '兴趣'],
  taskStatuses: ['待办', '进行中', '等待中', '暂停', '已完成', '已取消'],
  projectStatuses: ['待确认', '计划中', '进行中', '等待中', '暂停', '已完成', '已取消'],
  priorities: ['P0', 'P1', 'P2', 'P3']
};
const PRIORITY_LABELS = {P0: 'P0 · 紧急', P1: 'P1 · 高', P2: 'P2 · 正常', P3: 'P3 · 低'};
const DOMAIN_COLORS = {学业: 'blue', 工作: 'orange', 生活: 'green', 兴趣: 'purple', 私人: 'green'};
const CAPTURE_SECTIONS = {links: '参考链接与课程', ideas: '灵感与想法'};
const INBOX_TARGETS = {
  '兴趣项目': {kind: '兴趣项目', folder: '20-知识/开源项目'},
  '未读论文': {kind: '论文', folder: '20-知识/论文'},
  '课程与播客': {kind: '学习资料', folder: '20-知识/学习'},
  '随手想法': {kind: '想法', folder: '00-收件箱/想法'}
};
const ORDER_LABELS = {sections: '项目分段', references: '参考知识', ...CAPTURE_SECTIONS};
const RESOURCE_PLATFORMS = ['自动识别', 'YouTube', 'Hugging Face', 'GitHub', '网页 / 文档', '其他'];
const resourcePlatform = url => {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'YouTube';
  if (host === 'huggingface.co' || host.endsWith('.huggingface.co')) return 'Hugging Face';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'GitHub';
  return '网页 / 文档';
};
const markdownTitle = value => value.replace(/[\r\n]+/g, ' ').replace(/([\\\[\]])/g, '\\$1');
function projectSections(content) {
  const sections = [];
  let offset = getFrontMatterInfo(content).contentStart, fence = null, inComment = false;
  for (const line of content.slice(offset).match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue;
    const start = offset;
    offset += line.length;
    const raw = line.replace(/[\r\n]+$/, '');
    if (inComment) { if (raw.includes('-->')) inComment = false; continue; }
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(raw)) fence = null;
      continue;
    }
    if (raw.trimStart().startsWith('<!--')) { inComment = !raw.includes('-->'); continue; }
    const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (boundary) { fence = {char: boundary[1][0], length: boundary[1].length}; continue; }
    const heading = /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(raw);
    if (heading) sections.push({label: heading[1], start, contentStart: offset});
  }
  return sections.map((section, index) => ({...section, end: sections[index + 1]?.start ?? content.length}));
}
function captureSection(content, kind) {
  const section = projectSections(content).find(section => section.label === CAPTURE_SECTIONS[kind]);
  return section ? {start: section.contentStart, end: section.end} : null;
}
function projectOrderItems(content, kind) {
  if (kind === 'references') {
    const references = parts(content).frontmatter['参考知识'];
    return (Array.isArray(references) ? references : references ? [references] : []).map(value => {
      const path = text(value).replace(/^\[\[|\]\]$/g, '');
      return {value, label: path.includes('|') ? path.split('|').pop() : path.split('/').pop()};
    });
  }
  if (kind === 'sections') return projectSections(content).map(section => {
    const raw = content.slice(section.start, section.end).replace(/[\r\n]+$/, '');
    return {...section, end: section.start + raw.length, raw};
  });
  const range = captureSection(content, kind);
  if (!range) return [];
  const items = [];
  let offset = range.start, current = null;
  for (const line of content.slice(range.start, range.end).match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue;
    const start = offset;
    offset += line.length;
    const raw = line.replace(/[\r\n]+$/, '');
    if (current && /^>/.test(raw)) { current.end = start + raw.length; continue; }
    current = null;
    const heading = /^> \[!(?:info|tip)\][+-]?[ \t]*(.*)$/.exec(raw);
    if (heading) {
      const label = heading[1].replace(/^\[((?:\\.|[^\]])*)\]\(.*\)$/, '$1').replace(/\\([\\\[\]])/g, '$1');
      current = {label: label || '未命名条目', start, end: start + raw.length};
      items.push(current);
    }
  }
  return items.map(item => ({...item, raw: content.slice(item.start, item.end)}));
}
const folder = kind => kind === '项目' ? '10-项目' : '11-任务';
const text = value => value == null ? '' : String(value);
const link = file => `[[${file.path.replace(/\.md$/, '')}]]`;
const parts = content => {
  const info = getFrontMatterInfo(content);
  return {frontmatter: info.exists ? (parseYaml(info.frontmatter) || {}) : {}, body: content.slice(info.contentStart)};
};
const combine = (frontmatter, body) => `---\n${stringifyYaml(frontmatter)}---\n\n${body.trimStart()}`;

function projectToolbar(el, label, capture = false) {
  el.addClass('pt-project-controls');
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', label);
  return el.createDiv(capture ? 'pt-toolbar pt-capture-toolbar' : 'pt-toolbar');
}

function select(parent, label, current, options, onChange) {
  const input = parent.createEl('select', {attr: {'aria-label': label}});
  input.createEl('option', {text: '未设置', attr: {value: ''}});
  const entries = options.map(item => typeof item === 'string' ? [item, PRIORITY_LABELS[item] || item] : item);
  if (current && !entries.some(([value]) => value === current)) entries.push([current, current + '（现有值）']);
  for (const [value, title] of entries) input.createEl('option', {text: title, attr: {value}});
  input.value = current;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

class KnowledgePicker extends FuzzySuggestModal {
  constructor(plugin, onChoose) { super(plugin.app); this.onChoose = onChoose; this.setPlaceholder('搜索论文、主题或知识笔记…'); }
  getItems() { return this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('20-知识/')); }
  getItemText(file) { return file.basename; }
  onChooseItem(file) { this.onChoose(file); }
}

class ProjectOrderModal extends Modal {
  constructor(plugin, file, kind) { super(plugin.app); this.plugin = plugin; this.file = file; this.kind = kind; }
  async onOpen() {
    this.setTitle(`调整${ORDER_LABELS[this.kind]}顺序 · ${this.file.basename}`);
    this.contentEl.addClass('pt-order-modal');
    let snapshot;
    try { snapshot = await this.app.vault.read(this.file); }
    catch (error) { new Notice(error.message); this.close(); return; }
    const items = projectOrderItems(snapshot, this.kind);
    const order = items.map((_item, index) => index);
    this.contentEl.createEl('p', {text: '拖动左侧手柄，或点击“上移 / 下移”。点击保存后应用到当前项目。', cls: 'setting-item-description'});
    const list = this.contentEl.createDiv({cls: 'pt-order-list', attr: {role: 'list', 'aria-label': `${ORDER_LABELS[this.kind]}顺序`}});
    const status = this.contentEl.createDiv({cls: 'pt-hint', attr: {'aria-live': 'polite'}});
    let dragged = null;
    const clearDrop = () => list.querySelectorAll('.is-drop-before, .is-drop-after').forEach(row => row.removeClass('is-drop-before', 'is-drop-after'));
    const move = (from, to) => {
      if (from === to || to < 0 || to >= order.length) return;
      const [id] = order.splice(from, 1);
      order.splice(to, 0, id);
      render();
      status.setText(`${items[id].label}已移到第 ${to + 1} 位`);
      list.children[to]?.querySelector('.pt-order-handle')?.focus();
    };
    const render = () => {
      list.empty();
      if (!items.length) list.createEl('p', {text: this.kind === 'references' ? '暂无参考知识，请先通过“编辑属性 → 添加参考”关联笔记。' : '暂无可排序的条目。', cls: 'pt-hint'});
      for (let index = 0; index < order.length; index++) {
        const item = items[order[index]];
        const row = list.createDiv({cls: 'pt-order-row', attr: {role: 'listitem'}});
        const handle = row.createEl('button', {text: '⠿', cls: 'pt-order-handle', attr: {draggable: 'true', 'aria-label': `拖动 ${item.label}`, title: '拖动调整位置'}});
        row.createSpan({text: `${index + 1}. ${item.label}`, cls: 'pt-order-label', attr: {title: item.label}});
        for (const [delta, label] of [[-1, '上移'], [1, '下移']]) {
          const button = row.createEl('button', {text: label, attr: {'aria-label': `${label} ${item.label}`}});
          button.disabled = index + delta < 0 || index + delta >= order.length;
          button.onclick = () => move(index, index + delta);
        }
        handle.ondragstart = event => {
          dragged = index;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
        };
        handle.ondragend = () => { dragged = null; clearDrop(); };
        row.ondragover = event => {
          if (dragged == null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          clearDrop();
          const rect = row.getBoundingClientRect();
          row.addClass(event.clientY < rect.top + rect.height / 2 ? 'is-drop-before' : 'is-drop-after');
        };
        row.ondrop = event => {
          if (dragged == null) return;
          event.preventDefault();
          const rect = row.getBoundingClientRect();
          let to = index + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0);
          const from = dragged;
          if (from < to) to--;
          dragged = null;
          clearDrop();
          move(from, to);
        };
      }
    };
    render();
    const actions = this.contentEl.createDiv('pt-actions');
    actions.createEl('button', {text: '取消'}).onclick = () => this.close();
    const save = actions.createEl('button', {text: '保存顺序', cls: 'mod-cta'});
    save.disabled = items.length < 2;
    save.onclick = async () => {
      save.disabled = true;
      try {
        await this.plugin.saveProjectOrder(this.file, this.kind, snapshot, order);
        this.close();
        new Notice('已保存顺序');
      } catch (error) { new Notice(error.message); save.disabled = false; }
    };
  }
}

class ProjectCaptureModal extends Modal {
  constructor(plugin, file, kind) { super(plugin.app); this.plugin = plugin; this.file = file; this.kind = kind; }
  onOpen() {
    const isLink = this.kind === 'links';
    this.setTitle(`${isLink ? '添加参考链接' : '记录灵感'} · ${this.file.basename}`);
    this.contentEl.addClass('pt-capture-form');
    const values = {title: '', url: '', platform: '自动识别', status: '待整理', position: '', notes: ''};
    if (isLink) {
      new Setting(this.contentEl).setName('链接').addText(input => {
        input.setPlaceholder('粘贴 https://…').onChange(value => values.url = value);
        input.inputEl.setAttribute('aria-label', '参考链接');
        setTimeout(() => input.inputEl.focus(), 0);
      });
    }
    new Setting(this.contentEl).setName('标题').addText(input => {
      input.setPlaceholder(isLink ? '课程、仓库或资料的名称（可留空）' : '一句话概括（可留空）').onChange(value => values.title = value);
      input.inputEl.setAttribute('aria-label', '条目标题');
    });
    if (isLink) {
      const platform = new Setting(this.contentEl).setName('平台').setDesc('根据链接自动识别，也可自行选择');
      select(platform.controlEl, '资源平台', values.platform, RESOURCE_PLATFORMS, value => values.platform = value || '自动识别');
    }
    const status = new Setting(this.contentEl).setName('整理状态');
    select(status.controlEl, '条目整理状态', values.status, isLink ? ['待整理', '学习中', '已看完', '持续参考', '暂存'] : ['待整理', '待验证', '已采用', '暂存'], value => values.status = value || '待整理');
    if (isLink) new Setting(this.contentEl).setName('进度 / 使用位置').setDesc('例如第 3 课、视频 12:34、仓库路径或模型版本').addText(input => {
      input.setPlaceholder('可留空').onChange(value => values.position = value);
      input.inputEl.setAttribute('aria-label', '资源进度或位置');
    });
    const notes = new Setting(this.contentEl).setName(isLink ? '用途与摘记' : '想法内容').setClass('pt-description-setting');
    notes.addTextArea(input => {
      input.inputEl.rows = 5;
      input.inputEl.setAttribute('aria-label', isLink ? '资源用途与摘记' : '灵感内容');
      input.setPlaceholder(isLink ? '为什么收藏？对项目有什么帮助？记下重点或待验证的问题。' : '先记下想法，也可以粘贴链接、引用 [[知识笔记]] 或写验证思路。').onChange(value => values.notes = value);
      if (!isLink) setTimeout(() => input.inputEl.focus(), 0);
    });
    this.contentEl.createEl('p', {text: '保存到本项目正文。之后可用“编辑本区”修改、补充或删除条目。', cls: 'setting-item-description'});
    const actions = this.contentEl.createDiv('pt-actions');
    actions.createEl('button', {text: '取消'}).onclick = () => this.close();
    const save = actions.createEl('button', {text: '保存到项目', cls: 'mod-cta'});
    save.onclick = async () => {
      save.disabled = true;
      try {
        await this.plugin.saveProjectCapture(this.file, this.kind, values);
        this.close();
        await this.plugin.showProjectSection(this.file, this.kind, false);
      } catch (error) { new Notice(error.message); save.disabled = false; }
    };
  }
}

class InboxConvertModal extends Modal {
  constructor(plugin, file) { super(plugin.app); this.plugin = plugin; this.file = file; }
  async onOpen() {
    this.setTitle('转入工作台');
    this.contentEl.addClass('pt-capture-form');
    const {frontmatter} = parts(await this.app.vault.read(this.file));
    const values = {destination: '', title: this.file.basename, url: text(frontmatter['来源']), form: '课程', topics: '', project: ''};
    new Setting(this.contentEl).setName('转入位置').addDropdown(input => {
      input.selectEl.setAttribute('aria-label', '转入位置');
      input.addOption('', '选择去向');
      for (const name of [...Object.keys(INBOX_TARGETS), '已有项目']) input.addOption(name, name);
      input.onChange(value => { values.destination = value; update(); });
    });
    new Setting(this.contentEl).setName('名称').addText(input => {
      input.setValue(values.title).onChange(value => values.title = value);
      input.inputEl.setAttribute('aria-label', '归档名称');
    });
    new Setting(this.contentEl).setName('来源链接').addText(input => {
      input.setValue(values.url).onChange(value => values.url = value);
      input.inputEl.setAttribute('aria-label', '归档来源链接');
    });
    const topics = new Setting(this.contentEl).setName('主题').addText(input => {
      input.setPlaceholder('多个主题用逗号分隔').onChange(value => values.topics = value);
      input.inputEl.setAttribute('aria-label', '论文主题');
    });
    const form = new Setting(this.contentEl).setName('形式').addDropdown(input => {
      input.selectEl.setAttribute('aria-label', '学习资料形式');
      for (const name of ['课程', '播客', '视频', '文章']) input.addOption(name, name);
      input.setValue(values.form).onChange(value => values.form = value);
    });
    const project = new Setting(this.contentEl).setName('项目');
    select(project.controlEl, '目标项目', '', this.plugin.projectOptions(), value => values.project = value);
    const actions = this.contentEl.createDiv('pt-actions');
    actions.createEl('button', {text: '取消'}).onclick = () => this.close();
    const save = actions.createEl('button', {text: '转入', cls: 'mod-cta'});
    const update = () => {
      topics.settingEl.style.display = values.destination === '未读论文' ? '' : 'none';
      form.settingEl.style.display = values.destination === '课程与播客' ? '' : 'none';
      project.settingEl.style.display = values.destination === '已有项目' ? '' : 'none';
      save.disabled = !values.destination;
    };
    update();
    save.onclick = async () => {
      save.disabled = true;
      try {
        const target = await this.plugin.convertInbox(this.file, values);
        this.close();
        await this.plugin.openRecord(target);
        new Notice(`已转入${values.destination}`);
      } catch (error) { new Notice(error.message); update(); }
    };
  }
}

class RecordModal extends Modal {
  constructor(plugin, kind, file = null, initial = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.kind = kind;
    this.file = file;
    this.initial = initial;
    this.changes = {};
  }
  async onOpen() {
    this.setTitle(`${this.file ? '编辑' : '新建'}${this.kind}`);
    const original = this.file ? parts(await this.app.vault.read(this.file)).frontmatter : this.initial;
    if (!this.file) this.changes = {...this.plugin.defaults(this.kind), ...original};
    const values = {...original, ...this.changes};
    let name = this.file?.basename || '';
    const nameSetting = new Setting(this.contentEl).setName('名称').addText(input => {
      input.setValue(name).setPlaceholder(`${this.kind}名称`).onChange(value => name = value);
      if (!this.file) setTimeout(() => input.inputEl.focus(), 0);
    });
    nameSetting.controlEl.addClass('pt-wide');
    let description = '';
    if (!this.file) {
      const descriptionSetting = new Setting(this.contentEl).setName(this.kind === '项目' ? '目标与交付' : '行动内容');
      descriptionSetting.setClass('pt-description-setting').addTextArea(input => {
        input.inputEl.rows = 3;
        input.inputEl.setAttribute('aria-label', this.kind === '项目' ? '目标与交付' : '行动内容');
        input.setPlaceholder(this.kind === '项目' ? '这件事要达成什么？完成时交付什么？' : '记下要做的事和必要上下文…').onChange(value => description = value);
      });
    }
    const addSelect = (key, options) => {
      const row = new Setting(this.contentEl).setName(key === '领域' ? '分类' : key);
      const current = key === '项目' ? this.plugin.projectValue(values[key], this.file?.path) : text(values[key]);
      select(row.controlEl, key, current, options, value => this.changes[key] = value || null);
    };
    if (this.kind === '任务') addSelect('项目', this.plugin.projectOptions());
    addSelect('领域', this.plugin.settings.domains);
    addSelect('状态', this.plugin.statuses(this.kind));
    addSelect('优先级', this.plugin.settings.priorities);
    new Setting(this.contentEl).setName('截止日期').addText(input => {
      input.inputEl.type = 'date';
      input.setValue(text(values['截止日期'])).onChange(value => this.changes['截止日期'] = value || null);
    });
    if (this.kind === '项目') {
      new Setting(this.contentEl).setName('进度（0–100）').addText(input => {
        input.inputEl.type = 'number'; input.inputEl.min = '0'; input.inputEl.max = '100';
        input.setValue(text(values['进度'])).onChange(value => this.changes['进度'] = value === '' ? null : Number(value));
      });
      new Setting(this.contentEl).setName('下一步').addText(input => input.setValue(text(values['下一步'])).onChange(value => this.changes['下一步'] = value || null));
      const references = Array.isArray(values['参考知识']) ? [...values['参考知识']] : values['参考知识'] ? [values['参考知识']] : [];
      const referenceSetting = new Setting(this.contentEl).setName('参考知识').setDesc('链接已有论文、主题或知识笔记');
      const referenceList = this.contentEl.createDiv('pt-reference-list');
      const renderReferences = () => {
        referenceList.empty();
        for (const reference of references) {
          const chip = referenceList.createSpan('pt-reference-chip');
          chip.createSpan({text: text(reference).replace(/^\[\[|\]\]$/g, '').split('/').pop()});
          chip.createEl('button', {text: '×', attr: {'aria-label': `移除参考 ${reference}`}}).onclick = () => {
            references.splice(references.indexOf(reference), 1); this.changes['参考知识'] = [...references]; renderReferences();
          };
        }
      };
      referenceSetting.addButton(button => button.setButtonText('添加参考').onClick(() => new KnowledgePicker(this.plugin, file => {
        const alreadyLinked = references.some(value => this.app.metadataCache.getFirstLinkpathDest(text(value).replace(/^\[\[|\]\]$/g, '').split('|')[0], this.file?.path || '') === file);
        if (!alreadyLinked) references.push(link(file));
        this.changes['参考知识'] = [...references]; renderReferences();
      }).open()));
      renderReferences();
    }
    this.contentEl.createEl('p', {text: '保存后可在右侧笔记继续记录上下文和进展。未确定的日期与优先级可以留空。', cls: 'setting-item-description'});
    const actions = this.contentEl.createDiv('pt-actions');
    if (this.file) actions.createEl('button', {text: `删除${this.kind}`, cls: 'mod-warning'}).onclick = () => {
      this.close(); this.plugin.confirmDelete(this.file);
    };
    actions.createEl('button', {text: '取消'}).onclick = () => this.close();
    const save = actions.createEl('button', {text: this.file ? '保存' : '创建', cls: 'mod-cta'});
    save.onclick = async () => {
      save.disabled = true;
      try {
        const file = await this.plugin.saveRecord(this.kind, this.file, name, this.changes, description);
        this.close();
        if (!this.file) await this.plugin.openRecord(file);
      } catch (error) { new Notice(error.message); save.disabled = false; }
    };
  }
}

class DeleteModal extends Modal {
  constructor(plugin, file) { super(plugin.app); this.plugin = plugin; this.file = file; }
  onOpen() {
    this.setTitle(`删除“${this.file.basename}”？`);
    this.contentEl.createEl('p', {text: '这份笔记会移入本库的 .trash 回收站。相关项目、任务和附件不会一起删除。'});
    this.contentEl.createEl('p', {text: '删除后可点击通知里的“撤销”，或运行“项目与任务：撤销上次删除”。'});
    const actions = this.contentEl.createDiv('pt-actions');
    actions.createEl('button', {text: '取消'}).onclick = () => this.close();
    const remove = actions.createEl('button', {text: '移入回收站', cls: 'mod-warning'});
    remove.onclick = async () => {
      remove.disabled = true;
      try { await this.plugin.trashRecord(this.file); this.close(); }
      catch (error) { new Notice(error.message); remove.disabled = false; }
    };
  }
}

class RecordView extends BasesView {
  constructor(controller, parent, plugin) {
    super(controller); this.type = VIEW; this.plugin = plugin;
    this.containerEl = parent.createDiv('pt-view');
    this.register(() => this.containerEl.remove());
    this.plugin.views.add(this);
    this.register(() => this.plugin.views.delete(this));
  }
  onDataUpdated() {
    if (!this.data) return;
    this.containerEl.empty();
    const kind = this.config.get('recordType') === '项目' ? '项目' : '任务';
    const toolbar = this.containerEl.createDiv('pt-toolbar');
    toolbar.createEl('button', {text: `新建${kind}`, cls: 'mod-cta'}).onclick = () => {
      const initial = {};
      if (this.config.get('defaultDomain')) initial['领域'] = this.config.get('defaultDomain');
      if (kind === '任务' && this.config.get('projectContext')) {
        const value = this.config.getEvaluatedFormula(this, 'projectContext');
        const target = this.app.metadataCache.getFirstLinkpathDest(text(value).replace(/^\[\[|\]\]$/g, ''), '');
        if (target && this.plugin.kind(target) === '项目') initial['项目'] = link(target);
      }
      new RecordModal(this.plugin, kind, null, initial).open();
    };
    toolbar.createSpan({text: `${this.data.data.length} 项`, cls: 'pt-hint'});
    const layout = this.config.get('layout') === 'table' ? 'table' : 'list';
    const toggle = toolbar.createDiv('pt-layout-toggle');
    for (const [value, label] of [['list', '列表'], ['table', '表格']]) {
      const button = toggle.createEl('button', {text: label, cls: layout === value ? 'is-active' : '', attr: {'aria-pressed': String(layout === value)}});
      button.onclick = () => this.config.set('layout', value);
    }
    if (!this.data.data.length) {
      const empty = this.containerEl.createDiv('pt-empty');
      empty.createEl('p', {text: kind === '项目' ? '从一个目标开始' : '这里暂时没有任务', cls: 'pt-empty-title'});
      empty.createEl('p', {text: kind === '项目' ? '先写下想完成的事，再补上分类、日期和下一步。' : '点击“新建任务”记下行动。无日期的任务在“待处理”中，已结束的任务在“全部任务”中。'});
      return;
    }
    if (layout === 'list') { this.renderList(); return; }
    const scroller = this.containerEl.createDiv('pt-scroll');
    const table = scroller.createEl('table');
    const head = table.createEl('thead').createEl('tr');
    const columns = this.config.getOrder();
    for (const id of columns) head.createEl('th', {text: this.config.getDisplayName(id)});
    head.createEl('th', {text: '操作', cls: 'pt-row-actions'});
    const body = table.createEl('tbody');
    for (const group of this.data.groupedData) {
      if (group.hasKey()) body.createEl('tr').createEl('th', {text: text(group.key), attr: {colspan: String(columns.length + 1)}});
      for (const entry of group.entries) {
        const row = body.createEl('tr');
        for (const id of columns) this.renderCell(row.createEl('td'), entry, id);
        const actions = row.createEl('td', {cls: 'pt-row-actions'});
        const more = actions.createEl('button', {text: '···', cls: 'pt-more', attr: {'aria-label': `${entry.file.basename}：编辑、打开或删除`, 'aria-haspopup': 'menu', title: '更多操作'}});
        more.onclick = event => this.showRecordMenu(entry.file, event);
      }
    }
  }
  renderList() {
    const list = this.containerEl.createDiv('pt-list');
    list.setAttribute('role', 'list');
    for (const group of this.data.groupedData) {
      if (group.hasKey()) list.createEl('h3', {text: text(group.key), cls: 'pt-group-heading'});
      for (const entry of group.entries) {
        const file = entry.file;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const kind = this.plugin.kind(file);
        const row = list.createDiv({cls: 'pt-list-row', attr: {role: 'listitem'}});
        const title = row.createDiv('pt-list-title');
        const name = title.createEl('a', {text: file.basename, cls: 'pt-record-link', attr: {href: file.path, 'aria-label': `打开 ${file.basename}`}});
        name.onclick = event => { event.preventDefault(); this.plugin.openRecord(file, event.metaKey || event.ctrlKey).catch(error => new Notice(error.message)); };
        const next = text(fm['下一步']);
        const project = text(fm['项目']).replace(/^\[\[|\]\]$/g, '').split('/').pop();
        if (next || project) title.createDiv({text: next || project, cls: 'pt-list-preview'});
        const meta = row.createDiv('pt-list-meta');
        const status = select(meta, `${file.basename} · 状态`, text(fm['状态']), this.plugin.statuses(kind), value => this.writeListValue(file, '状态', value));
        status.addClass('pt-chip'); status.dataset.tone = ['已完成', '已取消'].includes(fm['状态']) ? 'green' : fm['状态'] === '进行中' ? 'blue' : 'neutral';
        status.title = '修改状态';
        if (fm['优先级']) {
          const priority = meta.createEl('button', {text: fm['优先级'], cls: 'pt-priority', attr: {'aria-label': `修改 ${file.basename} 的优先级`}});
          priority.dataset.level = fm['优先级']; priority.title = PRIORITY_LABELS[fm['优先级']] || fm['优先级'];
          priority.onclick = () => this.plugin.edit(file);
        }
        const due = meta.createEl('input', {cls: 'pt-list-date', attr: {type: 'date', 'aria-label': `${file.basename} · 截止日期`}});
        due.value = text(fm['截止日期']);
        due.title = text(entry.getValue('formula.deadline')) || '设置截止日期';
        due.classList.toggle('is-overdue', !!fm['截止日期'] && fm['截止日期'] < moment().format('YYYY-MM-DD') && !['已完成', '已取消'].includes(fm['状态']));
        due.onchange = () => this.writeListValue(file, '截止日期', due.value);
        const domain = select(meta, `${file.basename} · 分类`, text(fm['领域']), this.plugin.settings.domains, value => this.writeListValue(file, '领域', value));
        domain.addClass('pt-chip'); domain.dataset.tone = DOMAIN_COLORS[fm['领域']] || 'neutral';
        domain.options[0].text = '未分类'; domain.title = '修改分类';
        const more = meta.createEl('button', {text: '···', cls: 'pt-more', attr: {'aria-label': `${file.basename}：编辑、打开或删除`, 'aria-haspopup': 'menu', title: '更多操作'}});
        more.onclick = event => this.showRecordMenu(file, event);
        row.oncontextmenu = event => { event.preventDefault(); this.showRecordMenu(file, event); };
      }
    }
  }
  async writeListValue(file, property, value) {
    try { await this.plugin.setProperty(file, property, value || null); }
    catch (error) { new Notice(error.message); this.onDataUpdated(); }
  }
  showRecordMenu(file, event) {
    const menu = new Menu().setUseNativeMenu(false);
    menu.addItem(item => item.setTitle('编辑属性').setIcon('pencil').onClick(() => this.plugin.edit(file)));
    menu.addItem(item => item.setTitle('在右侧打开').setIcon('panel-right').onClick(() => this.plugin.openRecord(file)));
    menu.addItem(item => item.setTitle('在新标签页打开').setIcon('file-plus').onClick(() => this.plugin.openRecord(file, true)));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(`删除${this.plugin.kind(file)}`).setIcon('trash-2').setWarning(true).onClick(() => this.plugin.confirmDelete(file)));
    if (event.type === 'contextmenu') menu.showAtMouseEvent(event);
    else {
      const button = event.currentTarget;
      const rect = button.getBoundingClientRect();
      menu.showAtPosition({x: rect.left, y: rect.bottom}, button.ownerDocument);
    }
  }
  renderCell(cell, entry, id) {
    const file = entry.file;
    const property = id.replace(/^note\./, '');
    const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.[property];
    const value = id.startsWith('note.') ? text(raw) : text(entry.getValue(id));
    const kind = this.plugin.kind(file);
    const write = async input => {
      try { await this.plugin.setProperty(file, property, input); }
      catch (error) { new Notice(error.message); this.onDataUpdated(); }
    };
    if (id === 'file.name') {
      const a = cell.createEl('a', {text: file.basename, cls: 'internal-link', attr: {'data-href': file.path, href: file.path}});
      a.onclick = event => { event.preventDefault(); this.plugin.openRecord(file, event.ctrlKey || event.metaKey).catch(error => new Notice(error.message)); };
    } else if (id === 'note.状态') {
      select(cell, `${file.basename} · 状态`, value, this.plugin.statuses(kind), v => write(v || null));
    } else if (id === 'note.领域') {
      select(cell, `${file.basename} · 领域`, value, this.plugin.settings.domains, v => write(v || null));
    } else if (id === 'note.优先级') {
      select(cell, `${file.basename} · 优先级`, value, this.plugin.settings.priorities, v => write(v || null));
    } else if (id === 'note.项目') {
      const current = this.app.metadataCache.getFileCache(file)?.frontmatter?.['项目'];
      select(cell, `${file.basename} · 项目`, this.plugin.projectValue(current, file.path), this.plugin.projectOptions(), v => write(v || null));
    } else if (id === 'note.截止日期' || id === 'note.进度' || id === 'note.下一步') {
      const input = cell.createEl('input', {attr: {type: id === 'note.截止日期' ? 'date' : id === 'note.进度' ? 'number' : 'text', 'aria-label': `${file.basename} · ${property}`}});
      input.value = value;
      if (id === 'note.进度') { input.min = '0'; input.max = '100'; }
      input.onchange = () => write(input.value === '' ? null : id === 'note.进度' ? Number(input.value) : input.value);
    } else { cell.setText(value); }
  }
}

class OptionsSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl('h2', {text: '项目与任务的选项'});
    this.containerEl.createEl('p', {text: '每行一个选项。只影响项目与任务，不改变论文状态。已有的自定义值会保留。已完成、已取消用于结束筛选；P0–P3 用于默认优先级排序。'});
    for (const [key, name] of [['domains', '领域'], ['taskStatuses', '任务状态'], ['projectStatuses', '项目状态'], ['priorities', '优先级']]) {
      new Setting(this.containerEl).setName(name).addTextArea(input => {
        input.setValue(this.plugin.settings[key].join('\n'));
        input.inputEl.rows = 6;
        input.onChange(async value => {
          this.plugin.settings[key] = [...new Set(value.split('\n').map(v => v.trim()).filter(Boolean))];
          await this.plugin.saveData(this.plugin.settings);
          for (const view of this.plugin.views) view.onDataUpdated();
        });
      });
    }
  }
}

module.exports = class ProjectTasksPlugin extends Plugin {
  async onload() {
    this.settings = {...DEFAULTS, ...await this.loadData()};
    this.views = new Set();
    this.pending = new Map();
    this.addSettingTab(new OptionsSettings(this.app, this));
    const textWidget = this.app.metadataTypeManager.registeredTypeWidgets.text;
    const renderText = textWidget.render;
    const renderPlainIdea = function(container, value, context) {
      const options = context.key === '想法扩展'
        ? Object.assign(Object.create(context), {filterSuggestion: () => false})
        : context;
      return renderText.call(this, container, value, options);
    };
    textWidget.render = renderPlainIdea;
    this.register(() => {
      if (textWidget.render === renderPlainIdea) textWidget.render = renderText;
    });
    this.registerDomEvent(this.app.workspace.containerEl, 'click', event => {
      if (event.button !== 0 || event.shiftKey || event.altKey) return;
      const name = event.target.closest?.('.bases-td[data-property="file.name"] .internal-link');
      if (!name) return;
      const file = this.app.vault.getFileByPath(name.getAttribute('data-href') || '');
      if (!['想法', '学习资料', '论文', '兴趣项目'].includes(this.captureKindFromPath(file)) && !file?.path.startsWith('00-收件箱/Raindrop/')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openRecord(file, event.metaKey || event.ctrlKey).catch(error => new Notice(error.message));
    }, true);
    this.registerBasesView(VIEW, {
      name: '项目与任务', icon: 'list-todo',
      factory: (controller, container) => new RecordView(controller, container, this),
      options: () => [
        {type: 'dropdown', key: 'recordType', displayName: '记录类型', default: '任务', options: {任务: '任务', 项目: '项目'}},
        {type: 'dropdown', key: 'layout', displayName: '显示方式', default: 'list', options: {list: '简洁列表', table: '完整表格'}}
      ]
    });
    this.registerMarkdownCodeBlockProcessor('project-actions', (_source, el, ctx) => {
      const file = this.app.vault.getFileByPath(ctx.sourcePath);
      if (!file) return;
      const kind = this.kind(file);
      if (!kind) return;
      const bar = kind === '项目' ? projectToolbar(el, '项目操作') : el.createDiv('pt-toolbar');
      bar.createEl('button', {text: '编辑属性', cls: 'mod-cta'}).onclick = () => this.edit(file);
      if (kind === '项目') {
        bar.createEl('button', {text: '新建本项目任务'}).onclick = () => new RecordModal(this, '任务', null, {项目: link(file)}).open();
        bar.createEl('button', {text: '添加参考链接'}).onclick = () => new ProjectCaptureModal(this, file, 'links').open();
        bar.createEl('button', {text: '记录灵感'}).onclick = () => new ProjectCaptureModal(this, file, 'ideas').open();
        bar.createEl('button', {text: '调整分段顺序'}).onclick = () => new ProjectOrderModal(this, file, 'sections').open();
      }
      bar.createEl('button', {text: `删除${kind}`, cls: 'pt-delete'}).onclick = () => this.confirmDelete(file);
    });
    this.registerMarkdownCodeBlockProcessor('inbox-actions', (_source, el, ctx) => {
      const file = this.app.vault.getFileByPath(ctx.sourcePath);
      if (!file?.path.startsWith('00-收件箱/Raindrop/')) return;
      const bar = el.createDiv('pt-toolbar');
      bar.createEl('button', {text: '转入…', cls: 'mod-cta', attr: {'data-inbox-action': 'convert'}}).onclick = () => new InboxConvertModal(this, file).open();
    });
    this.registerMarkdownCodeBlockProcessor('project-capture', (source, el, ctx) => {
      const file = this.app.vault.getFileByPath(ctx.sourcePath);
      const kind = source.trim();
      if (this.kind(file) !== '项目' || !Object.hasOwn(CAPTURE_SECTIONS, kind)) return;
      const bar = projectToolbar(el, `${CAPTURE_SECTIONS[kind]}操作`, true);
      bar.createEl('button', {text: kind === 'links' ? '添加参考链接' : '记录灵感', cls: 'mod-cta'}).onclick = () => new ProjectCaptureModal(this, file, kind).open();
      bar.createEl('button', {text: '编辑本区', attr: {'aria-label': `编辑${CAPTURE_SECTIONS[kind]}`}}).onclick = () => this.showProjectSection(file, kind, true).catch(error => new Notice(error.message));
      bar.createEl('button', {text: '调整条目顺序', attr: {'aria-label': `调整${CAPTURE_SECTIONS[kind]}顺序`}}).onclick = () => new ProjectOrderModal(this, file, kind).open();
    });
    this.registerMarkdownCodeBlockProcessor('project-order', (source, el, ctx) => {
      const file = this.app.vault.getFileByPath(ctx.sourcePath);
      if (this.kind(file) !== '项目' || source.trim() !== 'references') return;
      const bar = projectToolbar(el, '参考知识操作', true);
      bar.createEl('button', {text: '调整条目顺序', attr: {'aria-label': '调整参考知识顺序'}}).onclick = () => new ProjectOrderModal(this, file, 'references').open();
    });
    this.addCommand({id: 'new-task', name: '新建任务', callback: () => new RecordModal(this, '任务').open()});
    this.addCommand({id: 'new-project', name: '新建项目', callback: () => new RecordModal(this, '项目').open()});
    this.addCommand({id: 'convert-inbox', name: '转入当前收藏', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file?.path.startsWith('00-收件箱/Raindrop/')) return false;
      if (!checking) new InboxConvertModal(this, file).open();
      return true;
    }});
    this.addCommand({id: 'edit-record', name: '编辑当前项目或任务', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!this.kind(file)) return false;
      if (!checking) this.edit(file); return true;
    }});
    this.addCommand({id: 'undo-delete', name: '撤销上次删除', callback: () => this.undoDelete().catch(e => new Notice(e.message))});
    this.addRibbonIcon('list-plus', '新建任务', () => new RecordModal(this, '任务').open());
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (this.kind(file)) menu.addItem(item => item.setTitle('编辑项目或任务属性').setIcon('list-todo').onClick(() => this.edit(file)));
    }));
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', file => {
        if (!this.kindFromPath(file) && !this.captureKindFromPath(file)) return;
        const timer = setTimeout(async () => {
          this.pending.delete(file);
          try { await this.applyTemplate(file); } catch (error) { new Notice(`自动模板：${error.message}`); }
        }, 300);
        this.pending.set(file, timer);
      }));
    });
    this.register(() => { for (const timer of this.pending.values()) clearTimeout(timer); });
  }
  kindFromPath(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    if (/^10-项目\/[^/]+\.md$/.test(file.path)) return '项目';
    if (/^11-任务\/[^/]+\.md$/.test(file.path)) return '任务';
    return null;
  }
  captureKindFromPath(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    if (/^00-收件箱\/想法\/[^/]+\.md$/.test(file.path)) return '想法';
    if (/^20-知识\/学习\/[^/]+\.md$/.test(file.path)) return '学习资料';
    if (/^20-知识\/论文\/[^/]+\.md$/.test(file.path)) return '论文';
    if (/^20-知识\/开源项目\/[^/]+\.md$/.test(file.path)) return '兴趣项目';
    return null;
  }
  kind(file) {
    if (!(file instanceof TFile)) return null;
    const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.['类型'];
    return type === '项目' || type === '任务' ? type : this.kindFromPath(file);
  }
  defaults(kind) { return {类型: kind, ...(kind === '任务' ? {项目: null} : {进度: 0}), 领域: null, 状态: kind === '任务' ? '待办' : '计划中', 优先级: null, 截止日期: null}; }
  statuses(kind) { return kind === '项目' ? this.settings.projectStatuses : this.settings.taskStatuses; }
  projectOptions() {
    return this.app.vault.getMarkdownFiles().filter(f => this.kind(f) === '项目' && !f.path.startsWith('99-系统/')).sort((a, b) => a.basename.localeCompare(b.basename, 'zh')).map(f => [link(f), f.basename]);
  }
  projectValue(value, source = '') {
    const match = text(value).match(/^\[\[(.*?)\]\]$/);
    const file = match && this.app.metadataCache.getFirstLinkpathDest(match[1].split('|')[0], source);
    return file && this.kind(file) === '项目' ? link(file) : text(value);
  }
  async template(kind, name) {
    const file = this.app.vault.getFileByPath(`99-系统/模板/${kind}.md`);
    if (!file) throw new Error(`找不到${kind}模板`);
    return (await this.app.vault.read(file)).replaceAll('{{title}}', name).replaceAll('{{date}}', moment().format('YYYY-MM-DD'));
  }
  async applyTemplate(file) {
    const kind = this.kindFromPath(file) || this.captureKindFromPath(file);
    if (!kind || this.app.vault.getFileByPath(file.path) !== file) return;
    const template = parts(await this.template(kind, file.basename));
    await this.app.vault.process(file, content => {
      const original = parts(content);
      if (original.body.trim() || (original.frontmatter['类型'] && original.frontmatter['类型'] !== kind)) return content;
      const merged = {...template.frontmatter, ...original.frontmatter};
      for (const [key, value] of Object.entries(template.frontmatter)) {
        if (merged[key] == null || merged[key] === '') merged[key] = value;
      }
      return combine(merged, template.body);
    });
  }
  validate(changes) {
    const progress = changes['进度'];
    if (progress != null && (!Number.isFinite(progress) || progress < 0 || progress > 100)) throw new Error('进度请填写 0–100 之间的数字');
    const due = changes['截止日期'];
    if (due && !moment(due, 'YYYY-MM-DD', true).isValid()) throw new Error('截止日期格式应为 YYYY-MM-DD');
  }
  async setProperty(file, property, value) {
    this.validate({[property]: value});
    await this.app.fileManager.processFrontMatter(file, fm => fm[property] = value);
  }
  async convertInbox(source, values) {
    if (!(source instanceof TFile) || !source.path.startsWith('00-收件箱/Raindrop/')) throw new Error('请先打开一条收藏');
    const {frontmatter: fm, body} = parts(await this.app.vault.read(source));
    const title = text(values.title).trim();
    if (!title || /[\\/:*?"<>|\[\]#\r\n]/.test(title) || ['.', '..'].includes(title)) throw new Error('请填写名称，且不要包含 / \\ : * ? " < > | [ ] #');
    let url = text(values.url).trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        url = parsed.href;
      } catch { throw new Error('请填写完整的 http:// 或 https:// 链接'); }
    }
    const originalBody = body.replace(/^```inbox-actions[^\n]*\n[\s\S]*?^```[ \t]*\n?/gm, '').trim();
    const hasNotes = originalBody.replace(/^## (?:我的笔记|摘录)[ \t]*$/gm, '').trim();
    const notes = [text(fm['摘要']).trim(), text(fm['收藏备注']).trim(), hasNotes ? originalBody : ''].filter(Boolean).join('\n\n');
    let target;
    if (values.destination === '已有项目') {
      const projectPath = text(values.project).replace(/^\[\[|\]\]$/g, '').split('|')[0];
      target = projectPath && this.app.metadataCache.getFirstLinkpathDest(projectPath, source.path);
      if (!target || this.kind(target) !== '项目') throw new Error('请选择目标项目');
      if (!url) throw new Error('加入项目参考资料时需要来源链接');
      const projectContent = await this.app.vault.read(target);
      const range = captureSection(projectContent, 'links');
      const section = range ? projectContent.slice(range.start, range.end) : '';
      if (!section.includes(`](<${url}>)`) && !section.includes(`](${url})`)) {
        await this.saveProjectCapture(target, 'links', {title, url, status: '待整理', notes: [`原始收藏：${link(source)}`, notes].filter(Boolean).join('\n\n')});
      }
    } else {
      const destination = INBOX_TARGETS[values.destination];
      if (!destination) throw new Error('请选择转入位置');
      const path = `${destination.folder}/${title}.md`;
      target = this.app.vault.getAbstractFileByPath(path);
      if (target) {
        if (!(target instanceof TFile)) throw new Error('已有同名目录，请修改名称');
        const existing = parts(await this.app.vault.read(target)).frontmatter;
        const origins = Array.isArray(existing['原始收藏']) ? existing['原始收藏'] : [existing['原始收藏']];
        if (!(url && existing['来源'] === url) && !origins.includes(link(source))) throw new Error('已有同名笔记，请修改名称；原笔记未覆盖');
        await this.app.fileManager.processFrontMatter(target, current => {
          const refs = Array.isArray(current['原始收藏']) ? current['原始收藏'] : current['原始收藏'] ? [current['原始收藏']] : [];
          current['原始收藏'] = [...new Set([...refs, link(source)])];
        });
      } else {
        if (!this.app.vault.getFolderByPath(destination.folder)) await this.app.vault.createFolder(destination.folder);
        const template = parts(await this.template(destination.kind, title));
        const metadata = {...template.frontmatter, 来源: url || null, 原始收藏: [link(source)]};
        if (Array.isArray(fm.tags) && fm.tags.length) metadata.tags = fm.tags;
        if (destination.kind === '论文') metadata['主题'] = [...new Set(text(values.topics).split(/[,，、\n]/).map(v => v.trim()).filter(Boolean))];
        if (destination.kind === '学习资料') metadata['形式'] = values.form || '课程';
        if (destination.kind === '兴趣项目') metadata['简介'] = text(fm['摘要']);
        const content = template.body.trimEnd() + (notes ? `\n\n## 收藏摘记\n\n${notes}` : '') + '\n';
        target = await this.app.vault.create(path, combine(metadata, content));
      }
    }
    await this.app.fileManager.processFrontMatter(source, current => {
      const refs = Array.isArray(current['归档笔记']) ? current['归档笔记'] : current['归档笔记'] ? [current['归档笔记']] : [];
      current['归档笔记'] = [...new Set([...refs, link(target)])];
      current['整理状态'] = '已整理';
    });
    return target;
  }
  async saveProjectOrder(file, kind, snapshot, order) {
    if (this.kind(file) !== '项目' || !Object.hasOwn(ORDER_LABELS, kind)) throw new Error('请在项目页调整顺序');
    const items = projectOrderItems(snapshot, kind);
    if (order.length !== items.length || new Set(order).size !== items.length || order.some(index => !Number.isInteger(index) || index < 0 || index >= items.length)) throw new Error('排序列表不完整，请重新打开排序窗口');
    if (order.every((id, index) => id === index)) return;
    await this.app.vault.process(file, content => {
      if (content !== snapshot) throw new Error('项目内容已变化，请重新打开排序窗口；本次未覆盖新内容');
      if (kind === 'references') {
        const original = parts(content);
        original.frontmatter['参考知识'] = order.map(index => items[index].value);
        return combine(original.frontmatter, original.body);
      }
      let result = content.slice(0, items[0].start);
      for (let index = 0; index < order.length; index++) {
        result += items[order[index]].raw;
        result += content.slice(items[index].end, items[index + 1]?.start ?? content.length);
      }
      return result;
    });
  }
  async saveProjectCapture(file, kind, values) {
    if (this.kind(file) !== '项目' || !Object.hasOwn(CAPTURE_SECTIONS, kind)) throw new Error('请在项目页记录资料或灵感');
    const notes = text(values.notes).trim();
    let url = '', platform = '', title = text(values.title).trim();
    if (kind === 'links') {
      try {
        const parsed = new URL(text(values.url).trim());
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
        url = parsed.href;
      } catch { throw new Error('请填写完整的 http:// 或 https:// 链接'); }
      platform = !values.platform || values.platform === '自动识别' ? resourcePlatform(url) : values.platform;
      title ||= new URL(url).hostname + new URL(url).pathname.replace(/\/$/, '');
    } else {
      if (!notes) throw new Error('请先写下想法内容');
      title ||= notes.split('\n')[0].slice(0, 60);
    }
    const time = moment().format('YYYY-MM-DD HH:mm');
    const lines = [kind === 'links' ? `[!info] [${markdownTitle(title)}](<${url}>)` : `[!tip] ${markdownTitle(title)}`];
    lines.push(`${kind === 'links' ? `**平台**：${platform} · ` : ''}**状态**：${text(values.status) || '待整理'} · **记录时间**：${time}`);
    if (kind === 'links' && text(values.position).trim()) lines.push(`**进度 / 使用位置**：${text(values.position).trim().replace(/[\r\n]+/g, ' ')}`);
    if (notes) lines.push('', ...notes.split('\n'));
    const entry = lines.map(line => line ? `> ${line}` : '>').join('\n');
    await this.app.vault.process(file, content => {
      let range = captureSection(content, kind);
      if (!range) {
        content = `${content.trimEnd()}\n\n## ${CAPTURE_SECTIONS[kind]}\n\n\`\`\`project-capture\n${kind}\n\`\`\`\n`;
        range = captureSection(content, kind);
      }
      const section = content.slice(range.start, range.end);
      if (url && (section.includes(`](<${url}>)`) || section.includes(`](${url})`))) throw new Error('本项目已保存这个链接，可用“编辑本区”补充已有记录');
      return `${content.slice(0, range.end).trimEnd()}\n\n${entry}\n\n${content.slice(range.end)}`;
    });
  }
  async showProjectSection(file, kind, edit) {
    await this.app.workspace.openLinkText(`${file.path}#${CAPTURE_SECTIONS[kind]}`, file.path, false, {state: {mode: edit ? 'source' : 'preview'}});
    if (!edit) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file !== file) return;
    const content = view.editor.getValue();
    const range = captureSection(content, kind);
    if (!range) return;
    const entry = /^> \[!/m.exec(content.slice(range.start, range.end));
    const offset = entry ? range.start + entry.index : range.end - content.slice(range.start, range.end).match(/\s*$/)[0].length;
    const pos = view.editor.offsetToPos(offset);
    view.editor.setCursor(pos);
    view.editor.scrollIntoView({from: pos, to: pos}, true);
    view.editor.focus();
  }
  async saveRecord(kind, file, name, changes, description = '') {
    name = name.trim();
    if (!name || /[\\/:*?"<>|\[\]#]/.test(name)) throw new Error('请填写名称，且不要包含 / \\ : * ? " < > | [ ] #');
    this.validate(changes);
    const destination = file ? `${file.parent.path}/${name}.md` : `${folder(kind)}/${name}.md`;
    const existing = this.app.vault.getAbstractFileByPath(destination);
    if (existing && existing !== file) throw new Error('已有同名笔记，请使用其他名称');
    if (file) {
      if (destination !== file.path) await this.app.fileManager.renameFile(file, destination);
      await this.app.fileManager.processFrontMatter(file, fm => Object.assign(fm, changes));
      return file;
    }
    const template = parts(await this.template(kind, name));
    if (description.trim()) {
      const heading = kind === '项目' ? '## 目标与完成标准' : '## 要做什么';
      template.body = template.body.includes(heading) ? template.body.replace(heading, `${heading}\n\n${description.trim()}`) : `${description.trim()}\n\n${template.body}`;
    }
    return await this.app.vault.create(destination, combine({...template.frontmatter, ...this.defaults(kind), ...changes, 类型: kind}, template.body));
  }
  async openRecord(file, newTab = false) {
    const options = ['想法', '兴趣项目'].includes(this.captureKindFromPath(file)) || file.path.startsWith('00-收件箱/Raindrop/') ? {state: {mode: 'source', source: false}} : undefined;
    if (newTab) return this.app.workspace.getLeaf('tab').openFile(file, options);
    let leaf = this.app.workspace.getLeafById(this.settings.previewLeafId || '');
    if (!leaf || !['markdown', 'empty'].includes(leaf.view.getViewType())) {
      leaf = this.app.workspace.getLeaf('split', 'vertical');
      this.settings.previewLeafId = leaf.id;
      await this.saveData(this.settings);
    }
    await leaf.openFile(file, options);
    await this.app.workspace.revealLeaf(leaf);
  }
  edit(file) { const kind = this.kind(file); if (kind) new RecordModal(this, kind, file).open(); }
  confirmDelete(file) { new DeleteModal(this, file).open(); }
  async trashRecord(file) {
    if (!this.kind(file)) throw new Error('请选择项目或任务笔记');
    const saved = {path: file.path, content: await this.app.vault.read(file)};
    await this.app.vault.trash(file, false);
    this.lastDeleted = saved;
    const fragment = document.createDocumentFragment();
    fragment.createSpan({text: `已移入回收站：${file.basename} `});
    fragment.createEl('button', {text: '撤销'}).onclick = () => this.undoDelete().catch(error => new Notice(error.message));
    new Notice(fragment, 12000);
  }
  async undoDelete() {
    const saved = this.lastDeleted;
    if (!saved) throw new Error('本次打开 Obsidian 后没有可撤销的删除；重启前删除的文件可从本库 .trash 恢复');
    if (this.app.vault.getAbstractFileByPath(saved.path)) throw new Error('原位置已有同名文件，未覆盖。请从 .trash 回收站手动恢复');
    await this.app.vault.create(saved.path, saved.content);
    this.lastDeleted = null;
    new Notice('已恢复原笔记');
  }
};
