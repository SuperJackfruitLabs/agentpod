import { Hono } from 'hono';

export const healthRoutes = new Hono()
  .get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  })
  .get('/api/info', (c) => {
    return c.json({
      name: 'Management API',
      version: '0.4.0',
      description: 'Portable Command Center - Project & Container Orchestration',
      status: 'running',
    });
  });
