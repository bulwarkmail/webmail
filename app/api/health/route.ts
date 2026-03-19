import v8 from 'node:v8';
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { calculateHeapUsagePercent } from '@/lib/health-memory';

// Health check thresholds
const MEMORY_WARNING_THRESHOLD = 0.85; // 85% heap usage
const MEMORY_CRITICAL_THRESHOLD = 0.95; // 95% heap usage

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime?: number;
  version?: string;
  memory?: {
    heapUsed: number;
    heapTotal: number;
    heapSizeLimit: number;
    rss: number;
    external: number;
    heapUsagePercent: number;
  };
  environment?: string;
  nodeVersion?: string;
  warnings?: string[];
  reason?: string;
}

/**
 * Health check endpoint for container orchestration
 *
 * GET /api/health - Basic health check (returns 200 OK or 503 Service Unavailable)
 * GET /api/health?detailed=true - Detailed diagnostics with memory stats
 * HEAD /api/health - Lightweight health check (status code only)
 *
 * Health status based on Node.js heap usage:
 * - Healthy (200): < 85% heap usage
 * - Degraded (200): 85-95% heap usage (warnings in detailed mode)
 * - Unhealthy (503): > 95% heap usage
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const detailed = searchParams.get('detailed') === 'true';

  try {
    const timestamp = new Date().toISOString();
    const memUsage = process.memoryUsage();
    const heapSizeLimit = process.constrainedMemory() || v8.getHeapStatistics().heap_size_limit;
    const heapUsagePercent = calculateHeapUsagePercent(memUsage.heapUsed, memUsage.heapTotal, heapSizeLimit);

    // Determine health status based on memory usage
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const warnings: string[] = [];
    let httpStatus = 200;

    if (heapUsagePercent >= MEMORY_CRITICAL_THRESHOLD * 100) {
      status = 'unhealthy';
      httpStatus = 503;
    } else if (heapUsagePercent >= MEMORY_WARNING_THRESHOLD * 100) {
      status = 'degraded';
      warnings.push(`Memory usage high: ${heapUsagePercent.toFixed(1)}%`);
    }

    // Build response
    const response: HealthStatus = {
      status,
      timestamp,
    };

    if (status === 'unhealthy') {
      response.reason = `Memory usage critical: ${heapUsagePercent.toFixed(1)}%`;
    }

    // Add detailed information if requested
    if (detailed) {
      response.uptime = process.uptime();
      response.version = process.env.npm_package_version || '0.1.0';
      response.memory = {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        heapSizeLimit,
        rss: memUsage.rss,
        external: memUsage.external,
        heapUsagePercent: Number(heapUsagePercent.toFixed(2)),
      };
      response.environment = process.env.NODE_ENV || 'development';
      response.nodeVersion = process.version;

      if (warnings.length > 0) {
        response.warnings = warnings;
      }
    }

    logger.info('Health check', { status, detailed });

    return NextResponse.json(response, {
      status: httpStatus,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });

  } catch (error) {
    logger.error('Health check failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        reason: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 503 }
    );
  }
}

/**
 * HEAD method for ultra-lightweight health checks
 */
export async function HEAD() {
  try {
    const memUsage = process.memoryUsage();
    const heapSizeLimit = process.constrainedMemory() || v8.getHeapStatistics().heap_size_limit;
    const heapUsagePercent = calculateHeapUsagePercent(memUsage.heapUsed, memUsage.heapTotal, heapSizeLimit);

    if (heapUsagePercent >= MEMORY_CRITICAL_THRESHOLD * 100) {
      return new Response(null, { status: 503 });
    }

    return new Response(null, { status: 200 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
