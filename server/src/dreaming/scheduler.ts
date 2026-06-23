import type { ProjectDreamCreateResult } from './service.js';

export type ProjectDreamingScheduleLogLevel = 'info' | 'error';

export type ProjectDreamingSchedulerParams = {
  intervalMs: number;
  listProjects: () => Promise<string[]>;
  createProject: (project: string) => Promise<ProjectDreamCreateResult>;
  log: (
    level: ProjectDreamingScheduleLogLevel,
    event: string,
    details: Record<string, unknown>,
  ) => Promise<void>;
};

export class ProjectDreamingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly params: ProjectDreamingSchedulerParams) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  async runOnce(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.runCycle().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private schedule(): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => {
        this.schedule();
      });
    }, this.params.intervalMs);
    this.timer.unref();
  }

  private async runCycle(): Promise<void> {
    let projects: string[];
    try {
      projects = await this.params.listProjects();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.params.log('error', 'project_dream_schedule_list_failed', { message });
      return;
    }
    for (const project of projects) {
      try {
        const result = await this.params.createProject(project);
        await this.params.log('info', 'project_dream_schedule_result', {
          project,
          created: result.created,
          rowCount: result.rows.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.params.log('error', 'project_dream_schedule_failed', {
          project,
          message,
        });
      }
    }
  }
}
