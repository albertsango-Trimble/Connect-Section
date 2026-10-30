import type { Topic } from '../connect/topicsApi';

type Listener = () => void;

/** The project's topics, shared by the topics panel and the map. */
class TopicsStore {
  topics: Topic[] = [];
  loading = false;
  error: string | null = null;
  /** Topic opened in the panel */
  openGuid: string | null = null;
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  set(partial: Partial<Pick<TopicsStore, 'topics' | 'loading' | 'error' | 'openGuid'>>): void {
    Object.assign(this, partial);
    this.listeners.forEach((l) => l());
  }

  upsert(topic: Topic): void {
    const i = this.topics.findIndex((t) => t.guid === topic.guid);
    const next = [...this.topics];
    if (i >= 0) next[i] = { ...next[i], ...topic };
    else next.unshift(topic);
    this.set({ topics: next });
  }
}

export const topicsStore = new TopicsStore();
