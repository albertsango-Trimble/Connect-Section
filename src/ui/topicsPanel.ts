import { DEFAULT_EXTENSIONS, sectionText, TopicsApi, type NewViewpoint, type Topic, type TopicExtensions, type TopicSection } from '../connect/topicsApi';
import { store } from '../state/store';
import { topicsStore } from '../state/topics';

export interface TopicsPanelOptions {
  button: HTMLElement;
  /** Returns the topics service for the project, or null when not running inside Connect */
  api: () => TopicsApi | null;
  /** The 3D viewer's current picture as a JPEG data URL */
  captureModel: () => Promise<string | null>;
  /** The map's current picture as a JPEG data URL */
  captureMap: () => string | null;
  /** The 3D camera now, with the section's clipping planes when there is a section */
  currentView: () => Promise<Omit<NewViewpoint, 'snapshot'> | null>;
  /** Brings back a section saved with a topic */
  showSection: (section: TopicSection) => void;
  /** Moves the map to a place given in model coordinates */
  showPlace: (x: number, y: number) => void;
  /** The signed-in user's email, once known, for "assigned to me" */
  me: () => string | undefined;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) el.className = String(cls);
  Object.assign(el, rest);
  el.append(...kids);
  return el;
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Toolbar "Topics" button and the slide-out panel for raising and following Connect topics. */
export function createTopicsPanel(opts: TopicsPanelOptions): { load: () => void } {
  let ext: TopicExtensions = DEFAULT_EXTENSIONS;
  let view: 'list' | 'new' | 'detail' = 'list';
  let filter = 'open';
  let loadedOnce = false;

  const panel = h('aside', { class: 'topics-panel' });
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Connect topics');
  document.body.append(panel);

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    opts.button.classList.toggle('active', open);
    if (open) {
      panel.style.top = `${(document.getElementById('toolbar')?.getBoundingClientRect().bottom ?? 40) + 4}px`;
      if (!loadedOnce) void load();
      render();
    }
  };
  opts.button.addEventListener('click', () => setOpen(panel.hidden));

  async function load() {
    const api = opts.api();
    if (!api) {
      topicsStore.set({ error: 'Topics are available when this extension runs inside Trimble Connect.' });
      return;
    }
    loadedOnce = true;
    topicsStore.set({ loading: true, error: null });
    try {
      const [topics, extensions] = await Promise.all([api.list(), api.options()]);
      ext = extensions;
      topicsStore.set({ topics, loading: false });
      // Pins come from each topic's viewpoint, fetched a few at a time.
      let next = 0;
      const worker = async () => {
        while (next < topics.length) {
          const t = topics[next++];
          const withPin = await api.pinOf(t);
          if (withPin.pin) topicsStore.upsert(withPin);
        }
      };
      await Promise.all(Array.from({ length: 5 }, worker));
    } catch (err) {
      loadedOnce = false;
      topicsStore.set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  topicsStore.subscribe(() => {
    if (topicsStore.openGuid) {
      view = 'detail';
      if (panel.hidden) setOpen(true);
    }
    if (!panel.hidden) render();
  });

  function header(title: string, back?: () => void) {
    const close = h('button', { class: 'topics-close', type: 'button', title: 'Close', textContent: '×' });
    close.addEventListener('click', () => setOpen(false));
    const kids: Node[] = [];
    if (back) {
      const b = h('button', { class: 'btn', type: 'button', textContent: '‹ Back' });
      b.addEventListener('click', back);
      kids.push(b);
    }
    kids.push(h('strong', { textContent: title }), close);
    return h('div', { class: 'topics-head' }, ...kids);
  }

  function select(options: string[], value?: string) {
    const s = h('select', { class: 'topics-input' });
    const list = value && !options.includes(value) ? [value, ...options] : options;
    list.forEach((o) => s.append(h('option', { value: o, textContent: o })));
    if (value) s.value = value;
    return s;
  }

  function assigneeSelect(current?: string) {
    const s = h('select', { class: 'topics-input' });
    s.append(h('option', { value: '', textContent: 'Unassigned' }));
    const users = current && !ext.users.includes(current) ? [current, ...ext.users] : ext.users;
    users.forEach((u) => s.append(h('option', { value: u, textContent: ext.userNames[u] && ext.userNames[u] !== u ? `${ext.userNames[u]} (${u})` : u })));
    s.value = current ?? '';
    return s;
  }

  const dateInput = (iso?: string) => h('input', { class: 'topics-input', type: 'date', value: iso ? iso.slice(0, 10) : '' });

  function render() {
    panel.replaceChildren();
    if (view === 'new') return renderNew();
    if (view === 'detail') return renderDetail();
    renderList();
  }

  // ---- List ----
  function renderList() {
    const add = h('button', { class: 'btn primary', type: 'button', textContent: '+ New topic' });
    add.addEventListener('click', () => {
      view = 'new';
      render();
    });
    const refresh = h('button', { class: 'btn', type: 'button', textContent: 'Refresh' });
    refresh.addEventListener('click', () => void load());
    const f = h('select', { class: 'topics-input' });
    [['open', 'Open topics'], ['mine', 'Assigned to me'], ['all', 'All topics'], ['closed', 'Closed topics']].forEach(([v, l]) => f.append(h('option', { value: v, textContent: l })));
    f.value = filter;
    f.addEventListener('change', () => {
      filter = f.value;
      render();
    });
    panel.append(header('Topics'), h('div', { class: 'topics-bar' }, add, refresh, f));

    const body = h('div', { class: 'topics-body' });
    panel.append(body);
    if (topicsStore.loading) body.append(h('p', { class: 'topics-note', textContent: 'Loading topics…' }));
    if (topicsStore.error) body.append(h('p', { class: 'topics-note error', textContent: topicsStore.error }));
    const isMine = (t: Topic) => {
      const me = opts.me()?.toLowerCase();
      return !!me && (t.assignedTo ?? '').toLowerCase() === me;
    };
    const isClosed = (t: Topic) => /clos|resolv|done|complete/i.test(t.status ?? '');
    const shown = topicsStore.topics.filter((t) => (filter === 'all' ? true : filter === 'closed' ? isClosed(t) : filter === 'mine' ? isMine(t) && !isClosed(t) : !isClosed(t)));
    if (!topicsStore.loading && !topicsStore.error && shown.length === 0) body.append(h('p', { class: 'topics-note', textContent: 'No topics to show.' }));
    shown
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      .forEach((t) => {
        const row = h('button', { class: 'topic-row', type: 'button' },
          h('span', { class: `topic-pin${t.pin ? ' has-pin' : ''}`, title: t.pin ? 'Shown on the map' : 'No location' }),
          h('span', { class: 'topic-main' },
            h('span', { class: 'topic-title', textContent: t.title }),
            h('span', { class: 'topic-meta', textContent: [t.status, t.priority, t.assignedTo && `→ ${t.assignedTo}`, t.dueDate && `due ${new Date(t.dueDate).toLocaleDateString()}`, when(t.created)].filter(Boolean).join(' · ') })));
        row.addEventListener('click', () => {
          topicsStore.set({ openGuid: t.guid });
        });
        body.append(row);
      });
  }

  // ---- New topic ----
  function renderNew() {
    const line = store.line;
    const section: TopicSection | null = line && store.section ? { a: line[0], b: line[1], side: store.side, depth: store.depth } : null;

    const title = h('input', { class: 'topics-input', type: 'text', placeholder: 'Title' });
    const desc = h('textarea', { class: 'topics-input', rows: 4, placeholder: 'Description' });
    const type = select(ext.types);
    const priority = select(ext.priorities, ext.priorities.find((p) => /normal|medium/i.test(p)));
    const status = select(ext.statuses);
    const assignee = assigneeSelect();
    const due = dateInput();
    const useModel = h('input', { type: 'checkbox', checked: false, disabled: true });
    let modelShot: string | null = null;
    const modelPreview = h('img', { class: 'topic-shot', alt: 'Current 3D view' });
    modelPreview.hidden = true;
    const mapShot = opts.captureMap();
    const useMap = h('input', { type: 'checkbox', checked: !!mapShot, disabled: !mapShot });
    const useView = h('input', { type: 'checkbox', checked: false, disabled: true });
    let camera: Omit<NewViewpoint, 'snapshot'> | null = null;
    const useSection = h('input', { type: 'checkbox', checked: !!section, disabled: !section });
    const extraFiles: string[] = [];
    const extraList = h('div', { class: 'topic-gallery' });
    const addShot = (jpg: string, label: string) => {
      extraFiles.push(jpg);
      const img = h('img', { class: 'topic-thumb', src: jpg, alt: label, title: `${label} (click to remove)` });
      img.addEventListener('click', () => {
        const i = extraFiles.indexOf(jpg);
        if (i >= 0) extraFiles.splice(i, 1);
        img.remove();
      });
      extraList.append(img);
    };
    const snap = (label: string, grab: () => string | null | Promise<string | null>) => {
      const b = h('button', { class: 'btn', type: 'button', textContent: label });
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const jpg = await grab();
          if (jpg) addShot(jpg, label);
          else {
            message.className = 'topics-note error';
            message.textContent = 'That view could not be captured.';
          }
        } finally {
          b.disabled = false;
        }
      });
      return b;
    };
    const addPics = h('div', { class: 'topics-actions' }, snap('+ New 3D screenshot', () => opts.captureModel()), snap('+ New map screenshot', () => opts.captureMap()));
    void opts.captureModel().then((shot3d) => {
      modelShot = shot3d;
      if (!shot3d) return;
      useModel.disabled = false;
      useModel.checked = true;
      modelPreview.src = shot3d;
      modelPreview.hidden = false;
    });
    void opts.currentView().then((v) => {
      camera = v;
      useView.disabled = !v;
      useView.checked = !!v;
    });
    const message = h('p', { class: 'topics-note' });
    const save = h('button', { class: 'btn primary', type: 'button', textContent: 'Create topic' });
    const cancel = h('button', { class: 'btn', type: 'button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => {
      view = 'list';
      render();
    });

    save.addEventListener('click', async () => {
      const api = opts.api();
      if (!api) return;
      if (!title.value.trim()) {
        message.className = 'topics-note error';
        message.textContent = 'Enter a title.';
        return;
      }
      save.disabled = true;
      message.className = 'topics-note';
      message.textContent = 'Creating topic…';
      try {
        const keepSection = useSection.checked && section;
        const lines = [desc.value.trim(), keepSection ? sectionText(section) : ''].filter(Boolean).join('\n\n');
        const viewpoint =
          useView.checked && camera
            ? { ...camera, clippingPlanes: keepSection ? camera.clippingPlanes : undefined, snapshot: useModel.checked && modelShot ? modelShot : undefined }
            : undefined;
        const extras = [...(!viewpoint && useModel.checked && modelShot ? [modelShot] : []), ...(useMap.checked && mapShot ? [mapShot] : []), ...extraFiles];
        const topic = await api.create(
          { title: title.value.trim(), description: lines, type: type.value, priority: priority.value, status: status.value, assignedTo: assignee.value || undefined, dueDate: due.value || undefined },
          viewpoint,
          extras,
        );
        topicsStore.upsert({ ...topic, section: keepSection ? section : undefined });
        view = 'list';
        render();
      } catch (err) {
        save.disabled = false;
        message.className = 'topics-note error';
        message.textContent = err instanceof Error ? err.message : String(err);
        void load();
      }
    });

    panel.append(
      header('New topic', () => {
        view = 'list';
        render();
      }),
      h('div', { class: 'topics-body' },
        title, desc,
        h('div', { class: 'topics-grid' }, h('label', {}, 'Type', type), h('label', {}, 'Priority', priority), h('label', {}, 'Status', status)),
        h('div', { class: 'topics-grid two' }, h('label', {}, 'Assign to', assignee), h('label', {}, 'Due date', due)),
        h('label', { class: 'topics-check' }, useModel, ' Attach a picture of the 3D section view'),
        modelPreview,
        h('label', { class: 'topics-check' }, useMap, ' Attach a picture of the map view'),
        ...(mapShot ? [h('img', { class: 'topic-shot', src: mapShot, alt: 'Current map view' })] : []),
        addPics,
        h('p', { class: 'topics-note', textContent: 'Move the views, then take as many screenshots as you need. Click a thumbnail to remove it.' }),
        extraList,
        h('label', { class: 'topics-check' }, useView, ' Save this 3D camera position and direction'),
        h('label', { class: 'topics-check' }, useSection, ' Save this section line and its clipping'),
        h('p', { class: 'topics-note', textContent: section ? 'The topic is shown on the map at the section, and opens with the same cut here and in the Connect 3D viewer.' : 'No section is drawn, so the topic is placed where the 3D camera is.' }),
        message,
        h('div', { class: 'topics-actions' }, cancel, save),
      ),
    );
  }

  // ---- Detail ----
  function renderDetail() {
    const topic = topicsStore.topics.find((t) => t.guid === topicsStore.openGuid);
    const back = () => {
      topicsStore.openGuid = null;
      view = 'list';
      render();
    };
    if (!topic) return back();
    const api = opts.api();
    const body = h('div', { class: 'topics-body' });
    panel.append(header(topic.title, back), body);

    body.append(h('p', { class: 'topic-meta', textContent: [topic.type, topic.priority, topic.author && `by ${topic.author}`, when(topic.created)].filter(Boolean).join(' · ') }));
    if (topic.description) body.append(h('p', { class: 'topic-desc', textContent: topic.description }));

    const gallery = h('div', { class: 'topic-gallery' });
    body.append(gallery);
    const loadPictures = async () => {
      if (!api) return;
      const guids = await api.viewpointGuids(topic.guid).catch(() => (topic.viewpointGuid ? [topic.viewpointGuid] : []));
      gallery.replaceChildren();
      for (const g of guids) {
        const url = await api.snapshot(topic, g);
        if (url) gallery.append(h('img', { class: 'topic-shot', src: url, alt: 'Topic picture' }));
      }
    };
    void loadPictures();

    const status = select(ext.statuses, topic.status);
    const assignee = assigneeSelect(topic.assignedTo);
    const due = dateInput(topic.dueDate);
    const setBtn = h('button', { class: 'btn primary', type: 'button', textContent: 'Save changes' });
    const msg = h('p', { class: 'topics-note' });
    setBtn.addEventListener('click', async () => {
      if (!api) return;
      setBtn.disabled = true;
      try {
        const saved = await api.update(topic, { status: status.value, assignedTo: assignee.value || undefined, dueDate: due.value || undefined });
        topicsStore.upsert(saved);
        msg.className = 'topics-note';
        msg.textContent = 'Saved.';
      } catch (err) {
        msg.className = 'topics-note error';
        msg.textContent = err instanceof Error ? err.message : String(err);
      }
      setBtn.disabled = false;
    });
    const attach = async (shot: string | null | Promise<string | null>, what: string) => {
      if (!api) return;
      msg.className = 'topics-note';
      msg.textContent = `Adding ${what}…`;
      try {
        const data = await shot;
        if (!data) throw new Error(`The ${what} could not be captured.`);
        await api.addPicture(topic.guid, data);
        msg.textContent = 'Picture added.';
        await loadPictures();
      } catch (err) {
        msg.className = 'topics-note error';
        msg.textContent = err instanceof Error ? err.message : String(err);
      }
    };
    const mk = (label: string, fn: () => void) => {
      const b = h('button', { class: 'btn', type: 'button', textContent: label });
      b.addEventListener('click', fn);
      return b;
    };
    const addBar = h('div', { class: 'topics-actions' },
      mk('+ New 3D screenshot', () => void attach(opts.captureModel(), '3D view')),
      mk('+ New map screenshot', () => void attach(opts.captureMap(), 'map view')),
    );
    body.append(addBar);
    body.append(h('div', { class: 'topics-grid two' }, h('label', {}, 'Status', status), h('label', {}, 'Assigned to', assignee), h('label', {}, 'Due date', due)), setBtn);

    if (topic.section || topic.pin) {
      const go = h('button', { class: 'btn', type: 'button', textContent: topic.section ? 'Show this section' : 'Go to this place' });
      go.addEventListener('click', () => {
        if (topic.section) opts.showSection(topic.section);
        else if (topic.pin) opts.showPlace(topic.pin.x, topic.pin.y);
      });
      body.append(go);
    }
    body.append(msg);

    const comments = h('div', { class: 'topic-comments' });
    body.append(h('strong', { textContent: 'Comments' }), comments);
    const loadComments = async () => {
      if (!api) return;
      try {
        const list = await api.comments(topic.guid);
        comments.replaceChildren(
          ...(list.length ? list.map((c) => h('div', { class: 'topic-comment' }, h('div', { class: 'topic-meta', textContent: [c.author, when(c.date)].filter(Boolean).join(' · ') }), h('div', { textContent: c.comment }))) : [h('p', { class: 'topics-note', textContent: 'No comments yet.' })]),
        );
      } catch (err) {
        comments.replaceChildren(h('p', { class: 'topics-note error', textContent: err instanceof Error ? err.message : String(err) }));
      }
    };
    void loadComments();

    const text = h('textarea', { class: 'topics-input', rows: 2, placeholder: 'Add a comment' });
    const post = h('button', { class: 'btn primary', type: 'button', textContent: 'Post comment' });
    post.addEventListener('click', async () => {
      if (!api || !text.value.trim()) return;
      post.disabled = true;
      try {
        await api.addComment(topic.guid, text.value.trim());
        text.value = '';
        await loadComments();
      } catch (err) {
        msg.className = 'topics-note error';
        msg.textContent = err instanceof Error ? err.message : String(err);
      }
      post.disabled = false;
    });
    body.append(text, post);
  }

  return {
    load: () => {
      if (!loadedOnce) void load();
    },
  };
}
