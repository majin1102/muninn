import { Hono } from 'hono';
import { assetRoutes } from './assets.js';
import { dreamingRoutes } from './dreaming.js';
import { importRoutes } from './import-routes.js';
import { pipelineRoutes } from './pipelines.js';
import { recallRoutes } from './recall-routes.js';
import { sessionRoutes } from './sessions.js';
import { settingsRoutes } from './settings.js';

export {
  SESSION_SNAPSHOTS_ROUTE,
  buildSessionSegmentsForTests,
  buildSessionTimelineForTests,
  buildSessionTurnPageForTests,
  buildTurnDetailForTests,
  buildTurnPreviewForTests,
  getSessionTreeLoadCountForTests,
  invalidateSessionTreeCache,
  resetSessionTreeCacheForTests,
  resolveSessionNodeFromIndexForTests,
  resolveSessionTreeNextOffsetForTests,
  __testing,
} from './sessions.js';

export const webRoutes = new Hono();

webRoutes.route('/', sessionRoutes);
webRoutes.route('/', recallRoutes);
webRoutes.route('/', dreamingRoutes);
webRoutes.route('/', pipelineRoutes);
webRoutes.route('/', settingsRoutes);
webRoutes.route('/', importRoutes);
webRoutes.route('/', assetRoutes);
