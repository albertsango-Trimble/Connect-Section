import type { ProjectFiles } from './projectFiles';

/** A Trimble Connect topic (BCF topic), reduced to the fields this extension shows. */
export interface Topic {
  guid: string;
  title: string;
  description?: string;
  status?: string;
  type?: string;
  priority?: string;
  assignedTo?: string;
  /** The 360 image the topic was raised on (file name), read from its description */
  imageName?: string;
  /** The section line the topic was raised on (model coordinates, metres), read from its description */
  section?: TopicSection;
  /** ISO date */
  dueDate?: string;
  created?: string;
  author?: string;
  /** Where the topic was raised, in project coordinates (metres), from its first viewpoint */
  pin?: { x: number; y: number; z: number };
  viewpointGuid?: string;
}

export interface TopicComment {
  guid: string;
  comment: string;
  author?: string;
  date?: string;
}

export interface TopicExtensions {
  statuses: string[];
  types: string[];
  priorities: string[];
  /** Project members' e-mail addresses, for assigning */
  users: string[];
  /** Display names by e-mail address */
  userNames: Record<string, string>;
}

/** A section line saved in a topic's description, so the topic can bring the same cut back. */
export interface TopicSection {
  a: [number, number];
  b: [number, number];
  side: 1 | -1;
  /** null when the depth was automatic */
  depth: number | null;
}

/** The line written into a topic's description for its section. */
export const sectionText = (s: TopicSection) =>
  `Section line: ${s.a[0].toFixed(3)}, ${s.a[1].toFixed(3)} → ${s.b[0].toFixed(3)}, ${s.b[1].toFixed(3)} (side ${s.side}, depth ${s.depth === null ? 'auto' : s.depth.toFixed(2)})`;

export function parseSection(text: string | undefined): TopicSection | undefined {
  const m = text?.match(/Section line:\s*(-?[\d.]+),\s*(-?[\d.]+)\s*(?:→|->)\s*(-?[\d.]+),\s*(-?[\d.]+)\s*(?:\(side\s*(-?1),\s*depth\s*(auto|[\d.]+)\))?/i);
  if (!m) return undefined;
  const n = m.slice(1, 5).map(Number);
  if (!n.every(Number.isFinite)) return undefined;
  return { a: [n[0], n[1]], b: [n[2], n[3]], side: m[5] === '-1' ? -1 : 1, depth: m[6] && m[6] !== 'auto' ? Number(m[6]) : null };
}

/** A BCF clipping plane: a point on it and the normal pointing to the side that is cut away (metres). */
export interface ClippingPlane {
  location: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

export interface NewViewpoint {
  position: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  fieldOfView: number;
  /** Orthographic view height (metres); when set the viewpoint is saved as an orthogonal camera */
  orthoSize?: number;
  /** The section's clipping planes, so the topic opens with the same cut in Connect */
  clippingPlanes?: ClippingPlane[];
  /** JPEG as a data URL */
  snapshot?: string;
}

export const DEFAULT_EXTENSIONS: TopicExtensions = {
  statuses: ['Open', 'In Progress', 'Closed'],
  types: ['Issue', 'Request', 'Comment'],
  priorities: ['Low', 'Normal', 'High', 'Critical'],
  users: [],
  userNames: {},
};

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Reads and writes topics through Trimble Connect's BCF 2.1 topics service. */
export class TopicsApi {
  private base: string | null = null;

  constructor(
    private readonly files: ProjectFiles,
    private readonly projectId: string,
  ) {}

  /** Trimble's open API hosts, one per region. Tokens are only ever sent to these Trimble addresses. */
  private static readonly OPEN_HOSTS: Record<string, string> = {
    northamerica: 'https://open11.connect.trimble.com',
    europe: 'https://open21.connect.trimble.com',
    asia: 'https://open31.connect.trimble.com',
    australia: 'https://open32.connect.trimble.com',
  };

  /** The BCF address for this project: the project's own region first, then the others. */
  private async root(): Promise<string> {
    if (this.base) return this.base;
    const pid = encodeURIComponent(this.projectId);
    const own = TopicsApi.OPEN_HOSTS[this.files.region()];
    const hosts = [own, ...Object.values(TopicsApi.OPEN_HOSTS).filter((h) => h !== own), 'https://openapi.connect.trimble.com'].filter(Boolean) as string[];
    const core = await this.files.apiHost().catch(() => null);
    const prefixes = [...hosts.map((h) => `${h}/bcf/2.1`), ...(core ? [`${core}/tc/api/2.0/bcf/2.1`] : [])];
    const tried: string[] = [];
    for (const prefix of prefixes) {
      const res = await fetch(`${prefix}/projects/${pid}/topics?$top=1`, { headers: this.files.authHeaders() }).catch(() => null);
      const label = `${new URL(prefix).hostname} ${res ? res.status : 'blocked/unreachable'}`;
      if (res?.ok) {
        this.base = `${prefix}/projects/${pid}`;
        return this.base;
      }
      tried.push(label);
      console.warn('[section viewer] topics service probe', label);
    }
    throw new Error(`Could not reach the Topics service (${tried.join(', ')}). Check that this extension is allowed to use Topics.`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${await this.root()}${path}`;
    const headers = new Headers(this.files.authHeaders());
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        // ignore
      }
      throw new Error(`Topics service replied ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  private async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    // Some replies (for example an empty comment list) come back with no body at all.
    const text = await (await this.request(path, init)).text();
    return (text.trim() ? JSON.parse(text) : []) as T;
  }

  private static toTopic(row: Json): Topic | null {
    const guid = str(row.guid);
    if (!guid) return null;
    return {
      guid,
      title: str(row.title) ?? '(untitled)',
      description: str(row.description),
      status: str(row.topic_status),
      type: str(row.topic_type),
      priority: str(row.priority),
      assignedTo: str(row.assigned_to),
      dueDate: str(row.due_date),
      imageName: str(row.description)?.match(/360 image:\s*(\S+)/i)?.[1],
      section: parseSection(str(row.description)),
      created: str(row.creation_date),
      author: str(row.creation_author),
    };
  }

  async list(): Promise<Topic[]> {
    const rows = await this.json<Json[]>('/topics');
    return (Array.isArray(rows) ? rows : []).map(TopicsApi.toTopic).filter((t): t is Topic => !!t);
  }

  /** The place a topic was raised: the camera position of its first viewpoint, if it has one. */
  async pinOf(topic: Topic): Promise<Topic> {
    try {
      const views = await this.json<Json[]>(`/topics/${topic.guid}/viewpoints`);
      for (const v of Array.isArray(views) ? views : []) {
        const cam = (v.perspective_camera ?? v.orthogonal_camera) as Json | undefined;
        const p = cam?.camera_view_point as Json | undefined;
        const x = num(p?.x);
        const y = num(p?.y);
        if (x !== undefined && y !== undefined) {
          return { ...topic, pin: { x, y, z: num(p?.z) ?? 0 }, viewpointGuid: str(v.guid) };
        }
      }
    } catch {
      // A topic without readable viewpoints simply has no pin.
    }
    return topic;
  }

  async extensions(): Promise<TopicExtensions> {
    for (const path of ['/extensions?includeUsers=true', '/project_extensions']) {
      try {
        const e = await this.json<Json>(path);
        const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
        const statuses = list(e.topic_status);
        const types = list(e.topic_type);
        const priorities = list(e.priority);
        const users = list(e.users);
        return {
          statuses: statuses.length ? statuses : DEFAULT_EXTENSIONS.statuses,
          types: types.length ? types : DEFAULT_EXTENSIONS.types,
          priorities: priorities.length ? priorities : DEFAULT_EXTENSIONS.priorities,
          users,
          userNames: {},
        };
      } catch {
        // try the next path
      }
    }
    return DEFAULT_EXTENSIONS;
  }

  /** Statuses, types and priorities from the topics service, plus the project's members from Connect. */
  async options(): Promise<TopicExtensions> {
    const [ext, members] = await Promise.all([this.extensions(), this.files.users()]);
    const userNames: Record<string, string> = { ...ext.userNames };
    members.forEach((m) => (userNames[m.email] = m.name));
    const users = [...new Set([...members.map((m) => m.email), ...ext.users])];
    return { ...ext, users, userNames };
  }

  /** Adds another picture (optionally with a camera) to an existing topic; returns the new viewpoint's guid. */
  async addPicture(topicGuid: string, snapshot: string, camera?: Omit<NewViewpoint, 'snapshot'>): Promise<string | undefined> {
    const viewpoint: Json = { snapshot: { snapshot_type: 'jpg', snapshot_data: snapshot.split(',')[1] ?? snapshot } };
    if (camera) {
      viewpoint.perspective_camera = {
        camera_view_point: camera.position,
        camera_direction: camera.direction,
        camera_up_vector: { x: 0, y: 0, z: 1 },
        field_of_view: camera.fieldOfView,
      };
    }
    const vp = await this.json<Json>(`/topics/${topicGuid}/viewpoints`, { method: 'POST', body: JSON.stringify(viewpoint) });
    return str(vp.guid);
  }

  /** Guids of every viewpoint on a topic, oldest first. */
  async viewpointGuids(topicGuid: string): Promise<string[]> {
    const rows = await this.json<Json[]>(`/topics/${topicGuid}/viewpoints`);
    return (Array.isArray(rows) ? rows : []).map((v) => str(v.guid)).filter((g): g is string => !!g);
  }

  async create(input: { title: string; description?: string; type?: string; priority?: string; status?: string; assignedTo?: string; dueDate?: string }, view?: NewViewpoint, extras: string[] = []): Promise<Topic> {
    const body: Json = { title: input.title };
    if (input.description) body.description = input.description;
    if (input.type) body.topic_type = input.type;
    if (input.priority) body.priority = input.priority;
    if (input.status) body.topic_status = input.status;
    if (input.assignedTo) body.assigned_to = input.assignedTo;
    if (input.dueDate) body.due_date = `${input.dueDate}T00:00:00Z`;
    const row = await this.json<Json>('/topics', { method: 'POST', body: JSON.stringify(body) });
    const topic = TopicsApi.toTopic(row);
    if (!topic) throw new Error('The Topics service did not return the new topic');
    const addExtras = async () => {
      for (const pic of extras) await this.addPicture(topic.guid, pic);
    };
    if (!view) {
      await addExtras().catch((err) => {
        throw new Error(`The topic was created, but a picture could not be attached (${err instanceof Error ? err.message : String(err)})`);
      });
      return topic;
    }
    const camera = { camera_view_point: view.position, camera_direction: view.direction, camera_up_vector: { x: 0, y: 0, z: 1 } };
    const viewpoint: Json =
      view.orthoSize !== undefined
        ? { orthogonal_camera: { ...camera, view_to_world_scale: view.orthoSize } }
        : { perspective_camera: { ...camera, field_of_view: view.fieldOfView } };
    if (view.clippingPlanes?.length) viewpoint.clipping_planes = view.clippingPlanes;
    const data = view.snapshot?.split(',')[1];
    if (data) viewpoint.snapshot = { snapshot_type: 'jpg', snapshot_data: data };
    try {
      const vp = await this.json<Json>(`/topics/${topic.guid}/viewpoints`, { method: 'POST', body: JSON.stringify(viewpoint) });
      await addExtras();
      return { ...topic, pin: { ...view.position }, viewpointGuid: str(vp.guid) };
    } catch (err) {
      // The topic exists; only the picture and camera were lost.
      console.warn('[section viewer] topic created but its viewpoint could not be saved', err);
      throw new Error(`The topic was created, but its views could not all be attached (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** Saves changes to a topic. A BCF update replaces the topic, so every field is sent. */
  async update(topic: Topic, patch: { status?: string; assignedTo?: string; dueDate?: string }): Promise<Topic> {
    const next = { ...topic, ...patch };
    const body: Json = { title: next.title };
    if (next.description) body.description = next.description;
    if (next.type) body.topic_type = next.type;
    if (next.priority) body.priority = next.priority;
    if (next.status) body.topic_status = next.status;
    if (next.assignedTo) body.assigned_to = next.assignedTo;
    if (next.dueDate) body.due_date = next.dueDate.length <= 10 ? `${next.dueDate}T00:00:00Z` : next.dueDate;
    await this.json(`/topics/${topic.guid}`, { method: 'PUT', body: JSON.stringify(body) });
    return next;
  }

  async comments(guid: string): Promise<TopicComment[]> {
    const rows = await this.json<Json[]>(`/topics/${guid}/comments`);
    return (Array.isArray(rows) ? rows : [])
      .map((r) => ({ guid: str(r.guid) ?? '', comment: str(r.comment) ?? '', author: str(r.author), date: str(r.date) }))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  }

  async addComment(guid: string, comment: string): Promise<void> {
    await this.json(`/topics/${guid}/comments`, { method: 'POST', body: JSON.stringify({ comment }) });
  }

  /** The picture saved with a topic's viewpoint, as a temporary object URL. */
  async snapshot(topic: Topic, viewpointGuid = topic.viewpointGuid): Promise<string | null> {
    if (!viewpointGuid) return null;
    try {
      const res = await this.request(`/topics/${topic.guid}/viewpoints/${viewpointGuid}/snapshot`);
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  }
}
