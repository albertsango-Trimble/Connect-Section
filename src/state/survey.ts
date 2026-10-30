import type { FeatureLibrary } from '../survey/fxl';
import type { JobXml } from '../survey/jobxml';
import { buildLinework, type StyledPoint, type SurveyString } from '../survey/linework';

type Listener = () => void;

/** One JobXML file loaded into the viewer. */
export interface SurveyJob {
  /** The project file id, or a made-up id for a file from this computer */
  id: string;
  fileName: string;
  job: JobXml;
  visible: boolean;
  /** Points and linework drawn with the current feature library */
  points: StyledPoint[];
  strings: SurveyString[];
  unknownCodes: string[];
}

/** A reference to one surveyed point. */
export interface SurveyRef {
  jobId: string;
  name: string;
}

/** Survey data shared by the map, the 3D pane and the survey panel. */
class SurveyStore {
  jobs: SurveyJob[] = [];
  library: FeatureLibrary | null = null;
  /** Where the library came from, e.g. "Civil.fxl (Project / Field Data)" */
  librarySource = '';
  /** Draw survey data in the 3D view as well as on the map */
  show3d = true;
  /** Incremented whenever what is drawn changes */
  version = 0;
  /** The surveyed point under the mouse on the map */
  hover: SurveyRef | null = null;

  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(changed = true): void {
    if (changed) this.version++;
    this.listeners.forEach((l) => l());
  }

  private draw(job: SurveyJob): void {
    const lw = buildLinework(job.job.points, this.library, job.job.lines);
    job.points = lw.points;
    job.strings = lw.strings;
    job.unknownCodes = lw.unknownCodes;
  }

  addJob(id: string, fileName: string, job: JobXml): SurveyJob {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    const entry: SurveyJob = { id, fileName, job, visible: true, points: [], strings: [], unknownCodes: [] };
    this.draw(entry);
    this.jobs.push(entry);
    this.emit();
    return entry;
  }

  removeJob(id: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.hover?.jobId === id) this.hover = null;
    this.emit();
  }

  setVisible(id: string, visible: boolean): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.visible === visible) return;
    job.visible = visible;
    this.emit();
  }

  /** Uses another feature library, and draws every job's linework again with it. */
  setLibrary(library: FeatureLibrary | null, source: string): void {
    this.library = library;
    this.librarySource = source;
    this.jobs.forEach((j) => this.draw(j));
    this.emit();
  }

  setShow3d(on: boolean): void {
    this.show3d = on;
    this.emit();
  }

  setHover(ref: SurveyRef | null): void {
    if (ref?.jobId === this.hover?.jobId && ref?.name === this.hover?.name) return;
    this.hover = ref;
    this.emit(false);
  }

  point(ref: SurveyRef | null): StyledPoint | undefined {
    if (!ref) return undefined;
    return this.jobs.find((j) => j.id === ref.jobId)?.points.find((p) => p.name === ref.name);
  }

  /** Every visible point and string, with the job each belongs to. */
  visible(): { job: SurveyJob; points: StyledPoint[]; strings: SurveyString[] }[] {
    return this.jobs.filter((j) => j.visible).map((job) => ({ job, points: job.points, strings: job.strings }));
  }
}

export const surveyStore = new SurveyStore();
