# Phase 2: Observability Stack

**Priority**: High  
**Estimated Time**: 3-4 hours  
**Prerequisites**: Phase 1 (Security) should be completed first

This phase sets up comprehensive logging, monitoring, and alerting using open-source tools.

## Overview

| Component | Purpose | RAM Usage |
|-----------|---------|-----------|
| Loki | Log aggregation & storage | ~150 MB |
| Fluent Bit | Log collection from containers | ~5 MB |
| Grafana | Visualization & alerting | ~150 MB |
| **Total** | | **~300 MB** |

---

## 2.1 Docker Compose Updates

**File**: `docker-compose.yml`

Add the following services after the `api` service:

```yaml
  # ===========================================================================
  # Observability Stack: Loki + Fluent Bit + Grafana
  # ===========================================================================

  # Log aggregation with Grafana Loki
  loki:
    image: grafana/loki:3.0.0
    container_name: agentpod-loki
    restart: unless-stopped
    command: -config.file=/etc/loki/local-config.yaml
    volumes:
      - ./config/loki/local-config.yaml:/etc/loki/local-config.yaml:ro
      - loki-data:/loki
    networks:
      - agentpod-net
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3100/ready || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
    labels:
      - "traefik.enable=false"
      - "agentpod.managed=false"

  # Lightweight log collector
  fluent-bit:
    image: fluent/fluent-bit:3.1
    container_name: agentpod-fluent-bit
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - ./config/fluent-bit/fluent-bit.conf:/fluent-bit/etc/fluent-bit.conf:ro
      - ./config/fluent-bit/parsers.conf:/fluent-bit/etc/parsers.conf:ro
      - fluent-bit-db:/fluent-bit/db
    networks:
      - agentpod-net
    depends_on:
      loki:
        condition: service_healthy
    labels:
      - "traefik.enable=false"
      - "agentpod.managed=false"

  # Visualization and alerting (internal only)
  grafana:
    image: grafana/grafana:11.0.0
    container_name: agentpod-grafana
    restart: unless-stopped
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_AUTH_ANONYMOUS_ENABLED=false
      - GF_SERVER_ENABLE_GZIP=true
      # Reduce resource usage
      - GF_ANALYTICS_REPORTING_ENABLED=false
      - GF_ANALYTICS_CHECK_FOR_UPDATES=false
      - GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false
      # Telegram alerting
      - GF_ALERTING_ENABLED=true
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
    volumes:
      - grafana-data:/var/lib/grafana
      - ./config/grafana/provisioning:/etc/grafana/provisioning:ro
    networks:
      - agentpod-net
    ports:
      # Internal only - access via SSH tunnel or Tailscale
      - "127.0.0.1:3000:3000"
    depends_on:
      loki:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
    labels:
      - "traefik.enable=false"
      - "agentpod.managed=false"
```

Add to the `volumes` section:

```yaml
volumes:
  postgres-data:
    driver: local
  agentpod-data:
    driver: local
  loki-data:
    driver: local
  grafana-data:
    driver: local
  fluent-bit-db:
    driver: local
```

---

## 2.2 Loki Configuration

**File**: `config/loki/local-config.yaml`

```yaml
# Loki Configuration for Single VPS
# Optimized for low resource usage

auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: warn

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /loki/tsdb-index
    cache_location: /loki/tsdb-cache

# Ingestion limits
limits_config:
  ingestion_rate_mb: 4
  ingestion_burst_size_mb: 6
  max_streams_per_user: 1000
  max_line_size: 256kb
  reject_old_samples: true
  reject_old_samples_max_age: 168h  # 7 days

# Retention (keep 30 days of logs)
compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  retention_delete_worker_count: 150
  delete_request_store: filesystem

# Query limits
query_range:
  align_queries_with_step: true
  max_retries: 5
  cache_results: true

# Reduce memory usage
chunk_store_config:
  max_look_back_period: 0s

table_manager:
  retention_deletes_enabled: true
  retention_period: 720h  # 30 days
```

---

## 2.3 Fluent Bit Configuration

### File 1: `config/fluent-bit/fluent-bit.conf`

```ini
# Fluent Bit Configuration
# Collects Docker container logs and forwards to Loki

[SERVICE]
    Flush        5
    Daemon       Off
    Log_Level    warn
    Parsers_File parsers.conf
    HTTP_Server  On
    HTTP_Listen  0.0.0.0
    HTTP_Port    2020
    Health_Check On

# ===========================================================================
# INPUT: Docker Container Logs
# ===========================================================================
[INPUT]
    Name              tail
    Path              /var/lib/docker/containers/*/*.log
    Parser            docker
    Tag               docker.*
    Refresh_Interval  10
    Rotate_Wait       30
    Mem_Buf_Limit     10MB
    Skip_Long_Lines   On
    DB                /fluent-bit/db/docker-logs.db
    DB.locking        true

# ===========================================================================
# FILTER: Extract container metadata
# ===========================================================================
[FILTER]
    Name          parser
    Match         docker.*
    Key_Name      log
    Parser        json_parser
    Reserve_Data  True
    Preserve_Key  False

# Add hostname
[FILTER]
    Name          record_modifier
    Match         *
    Record        hostname ${HOSTNAME}

# Extract container name from path
[FILTER]
    Name          lua
    Match         docker.*
    Script        /fluent-bit/etc/extract_container.lua
    Call          extract_container_name

# ===========================================================================
# OUTPUT: Send to Loki
# ===========================================================================
[OUTPUT]
    Name        loki
    Match       docker.*
    Host        loki
    Port        3100
    Labels      job=docker, host=${HOSTNAME}
    Label_Keys  $container_name,$level
    Remove_Keys container_id,stream
    Line_Format json
    Auto_Kubernetes_Labels Off
```

### File 2: `config/fluent-bit/parsers.conf`

```ini
# Fluent Bit Parsers

[PARSER]
    Name        docker
    Format      json
    Time_Key    time
    Time_Format %Y-%m-%dT%H:%M:%S.%L
    Time_Keep   On

[PARSER]
    Name        json_parser
    Format      json
    Time_Key    timestamp
    Time_Format %Y-%m-%dT%H:%M:%S.%LZ
    Time_Keep   On

[PARSER]
    Name        syslog
    Format      regex
    Regex       ^\<(?<pri>[0-9]+)\>(?<time>[^ ]* {1,2}[^ ]* [^ ]*) (?<host>[^ ]*) (?<ident>[a-zA-Z0-9_\/\.\-]*)(?:\[(?<pid>[0-9]+)\])?(?:[^\:]*\:)? *(?<message>.*)$
    Time_Key    time
    Time_Format %b %d %H:%M:%S
```

### File 3: `config/fluent-bit/extract_container.lua`

```lua
-- Extract container name from Docker log path
function extract_container_name(tag, timestamp, record)
    -- Tag format: docker.var.lib.docker.containers.<container_id>.<container_id>-json.log
    local container_id = tag:match("containers%.([^%.]+)%.")
    
    if container_id then
        record["container_id"] = container_id:sub(1, 12)  -- Short ID
        
        -- Try to get container name from record if available
        if record["container_name"] == nil then
            record["container_name"] = container_id:sub(1, 12)
        end
    end
    
    -- Extract log level if present
    if record["level"] == nil then
        local log = record["log"] or record["message"] or ""
        if log:match("[Ee]rror") or log:match("ERROR") then
            record["level"] = "error"
        elseif log:match("[Ww]arn") or log:match("WARN") then
            record["level"] = "warn"
        elseif log:match("[Dd]ebug") or log:match("DEBUG") then
            record["level"] = "debug"
        else
            record["level"] = "info"
        end
    end
    
    return 1, timestamp, record
end
```

---

## 2.4 Grafana Provisioning

### File 1: `config/grafana/provisioning/datasources/loki.yaml`

```yaml
apiVersion: 1

datasources:
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    isDefault: true
    editable: false
    jsonData:
      maxLines: 1000
      derivedFields:
        - name: RequestId
          matcherRegex: '"requestId":"([^"]+)"'
          url: ''
```

### File 2: `config/grafana/provisioning/alerting/telegram.yaml`

```yaml
apiVersion: 1

contactPoints:
  - orgId: 1
    name: telegram-alerts
    receivers:
      - uid: telegram-receiver
        type: telegram
        settings:
          bottoken: ${TELEGRAM_BOT_TOKEN}
          chatid: ${TELEGRAM_CHAT_ID}
          parse_mode: HTML
        disableResolveMessage: false

policies:
  - orgId: 1
    receiver: telegram-alerts
    group_by:
      - alertname
      - severity
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    routes:
      - receiver: telegram-alerts
        object_matchers:
          - - severity
            - =
            - critical
        continue: false
      - receiver: telegram-alerts
        object_matchers:
          - - severity
            - =
            - warning
        group_wait: 1m
        repeat_interval: 1h
```

### File 3: `config/grafana/provisioning/dashboards/dashboards.yaml`

```yaml
apiVersion: 1

providers:
  - name: AgentPod Dashboards
    orgId: 1
    folder: AgentPod
    folderUid: agentpod
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards/json
```

### File 4: `config/grafana/provisioning/dashboards/json/agentpod-overview.json`

```json
{
  "annotations": {
    "list": []
  },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [
    {
      "datasource": {
        "type": "loki",
        "uid": "loki"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "palette-classic"
          },
          "custom": {
            "axisBorderShow": false,
            "axisCenteredZero": false,
            "axisColorMode": "text",
            "axisLabel": "",
            "axisPlacement": "auto",
            "barAlignment": 0,
            "drawStyle": "bars",
            "fillOpacity": 100,
            "gradientMode": "none",
            "hideFrom": {
              "legend": false,
              "tooltip": false,
              "viz": false
            },
            "insertNulls": false,
            "lineInterpolation": "linear",
            "lineWidth": 1,
            "pointSize": 5,
            "scaleDistribution": {
              "type": "linear"
            },
            "showPoints": "never",
            "spanNulls": false,
            "stacking": {
              "group": "A",
              "mode": "normal"
            },
            "thresholdsStyle": {
              "mode": "off"
            }
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              }
            ]
          },
          "unit": "short"
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "error"
            },
            "properties": [
              {
                "id": "color",
                "value": {
                  "fixedColor": "red",
                  "mode": "fixed"
                }
              }
            ]
          },
          {
            "matcher": {
              "id": "byName",
              "options": "warn"
            },
            "properties": [
              {
                "id": "color",
                "value": {
                  "fixedColor": "yellow",
                  "mode": "fixed"
                }
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 8,
        "w": 24,
        "x": 0,
        "y": 0
      },
      "id": 1,
      "options": {
        "legend": {
          "calcs": ["sum"],
          "displayMode": "table",
          "placement": "right",
          "showLegend": true
        },
        "tooltip": {
          "mode": "multi",
          "sort": "desc"
        }
      },
      "targets": [
        {
          "datasource": {
            "type": "loki",
            "uid": "loki"
          },
          "expr": "sum by (level) (count_over_time({job=\"docker\"} | json | level != \"\" [$__interval]))",
          "legendFormat": "{{level}}",
          "refId": "A"
        }
      ],
      "title": "Log Volume by Level",
      "type": "timeseries"
    },
    {
      "datasource": {
        "type": "loki",
        "uid": "loki"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "palette-classic"
          },
          "custom": {
            "axisBorderShow": false,
            "axisCenteredZero": false,
            "axisColorMode": "text",
            "axisLabel": "",
            "axisPlacement": "auto",
            "barAlignment": 0,
            "drawStyle": "line",
            "fillOpacity": 10,
            "gradientMode": "none",
            "hideFrom": {
              "legend": false,
              "tooltip": false,
              "viz": false
            },
            "insertNulls": false,
            "lineInterpolation": "smooth",
            "lineWidth": 2,
            "pointSize": 5,
            "scaleDistribution": {
              "type": "linear"
            },
            "showPoints": "never",
            "spanNulls": false,
            "stacking": {
              "group": "A",
              "mode": "none"
            },
            "thresholdsStyle": {
              "mode": "off"
            }
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              }
            ]
          },
          "unit": "short"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 8
      },
      "id": 2,
      "options": {
        "legend": {
          "calcs": ["mean", "max"],
          "displayMode": "table",
          "placement": "bottom",
          "showLegend": true
        },
        "tooltip": {
          "mode": "multi",
          "sort": "desc"
        }
      },
      "targets": [
        {
          "datasource": {
            "type": "loki",
            "uid": "loki"
          },
          "expr": "sum by (container_name) (count_over_time({job=\"docker\"} [$__interval]))",
          "legendFormat": "{{container_name}}",
          "refId": "A"
        }
      ],
      "title": "Logs by Container",
      "type": "timeseries"
    },
    {
      "datasource": {
        "type": "loki",
        "uid": "loki"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "yellow",
                "value": 10
              },
              {
                "color": "red",
                "value": 50
              }
            ]
          },
          "unit": "short"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 8
      },
      "id": 3,
      "options": {
        "colorMode": "value",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": ["sum"],
          "fields": "",
          "values": false
        },
        "showPercentChange": false,
        "textMode": "auto",
        "wideLayout": true
      },
      "targets": [
        {
          "datasource": {
            "type": "loki",
            "uid": "loki"
          },
          "expr": "sum(count_over_time({job=\"docker\"} | json | level=\"error\" [5m]))",
          "legendFormat": "Errors (5m)",
          "refId": "A"
        }
      ],
      "title": "Errors (Last 5 min)",
      "type": "stat"
    },
    {
      "datasource": {
        "type": "loki",
        "uid": "loki"
      },
      "gridPos": {
        "h": 12,
        "w": 24,
        "x": 0,
        "y": 16
      },
      "id": 4,
      "options": {
        "dedupStrategy": "none",
        "enableLogDetails": true,
        "prettifyLogMessage": true,
        "showCommonLabels": false,
        "showLabels": false,
        "showTime": true,
        "sortOrder": "Descending",
        "wrapLogMessage": true
      },
      "targets": [
        {
          "datasource": {
            "type": "loki",
            "uid": "loki"
          },
          "expr": "{job=\"docker\"} | json | level=\"error\"",
          "refId": "A"
        }
      ],
      "title": "Recent Errors",
      "type": "logs"
    }
  ],
  "schemaVersion": 39,
  "tags": ["agentpod", "logs"],
  "templating": {
    "list": []
  },
  "time": {
    "from": "now-1h",
    "to": "now"
  },
  "timepicker": {},
  "timezone": "browser",
  "title": "AgentPod Overview",
  "uid": "agentpod-overview",
  "version": 1,
  "weekStart": ""
}
```

---

## 2.5 Structured Logging

**File**: `apps/api/src/utils/logger.ts` (Updated)

```typescript
/**
 * Structured Logging Utility
 * 
 * Outputs JSON-formatted logs for Loki ingestion.
 * Includes request context, user info, and timing.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  component: string;
  message: string;
  context?: LogContext;
}

// Log level from environment
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

function formatLog(entry: LogEntry): string {
  return JSON.stringify(entry);
}

class Logger {
  private component: string;
  private service = 'agentpod-api';

  constructor(component: string) {
    this.component = component;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      component: this.component,
      message,
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    };

    const output = formatLog(entry);

    switch (level) {
      case 'error':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  // Create a child logger with additional context
  child(additionalContext: LogContext): Logger {
    const childLogger = new Logger(this.component);
    const originalLog = childLogger.log.bind(childLogger);
    
    childLogger.log = (level: LogLevel, message: string, context?: LogContext) => {
      originalLog(level, message, { ...additionalContext, ...context });
    };
    
    return childLogger;
  }
}

/**
 * Create a logger for a specific component
 */
export function createLogger(component: string): Logger {
  return new Logger(component);
}

/**
 * Request logging middleware helper
 */
export function logRequest(
  logger: Logger,
  method: string,
  path: string,
  status: number,
  durationMs: number,
  userId?: string,
  requestId?: string
): void {
  const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  
  logger.log(level, `${method} ${path} ${status}`, {
    method,
    path,
    status,
    durationMs,
    userId,
    requestId,
  });
}

// Default export for backward compatibility
export default createLogger;
```

---

## 2.6 Environment Variables

Add to `.env.example`:

```bash
# =============================================================================
# OBSERVABILITY CONFIGURATION
# =============================================================================

# Log level (debug, info, warn, error)
LOG_LEVEL=info

# Grafana admin password (CHANGE IN PRODUCTION!)
# Access via SSH tunnel: ssh -L 3000:localhost:3000 user@your-vps
GRAFANA_PASSWORD=admin

# Telegram alerting (optional)
# 1. Create bot: Message @BotFather, send /newbot
# 2. Get chat ID: Message your bot, then visit:
#    https://api.telegram.org/bot<TOKEN>/getUpdates
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## 2.7 Setting Up Telegram Alerts

### Step 1: Create Telegram Bot

1. Open Telegram and message `@BotFather`
2. Send `/newbot`
3. Follow prompts to name your bot
4. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Step 2: Get Your Chat ID

1. Start a chat with your new bot (send any message)
2. Open in browser: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find the `"chat":{"id":123456789}` value

### Step 3: Configure Environment

```bash
# In your .env file
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

### Step 4: Test Alerts

After deploying, create a test alert in Grafana:
1. Go to Alerting > Alert Rules
2. Create new rule
3. Set condition to always fire
4. Save and wait for notification

---

## 2.8 Accessing Grafana

Grafana is configured for internal-only access. Choose one method:

### Option 1: SSH Tunnel (Recommended)

```bash
# From your local machine
ssh -L 3000:localhost:3000 user@your-vps-ip

# Then open in browser
open http://localhost:3000
```

### Option 2: Tailscale (If Configured)

```bash
# Access via Tailscale IP
open http://100.x.x.x:3000
```

### Default Credentials

- **Username**: `admin`
- **Password**: Value of `GRAFANA_PASSWORD` (default: `admin`)

**Important**: Change the password on first login!

---

## 2.9 Useful LogQL Queries

Save these in Grafana for quick access:

```logql
# All errors in last hour
{job="docker"} | json | level="error"

# API errors only
{job="docker", container_name=~"agentpod-api.*"} | json | level="error"

# Auth failures
{job="docker"} | json | message=~".*[Aa]uthentication failed.*"

# Rate limit hits
{job="docker"} | json | message=~".*[Rr]ate limit.*"

# Slow requests (>1s)
{job="docker"} | json | durationMs > 1000

# Container startup/shutdown
{job="docker"} | json | message=~".*(Starting|Shutting down|Started|Stopped).*"

# Errors by container (last 5 min)
sum by (container_name) (count_over_time({job="docker"} | json | level="error" [5m]))
```

---

## Checklist

- [ ] Create `config/loki/local-config.yaml`
- [ ] Create `config/fluent-bit/fluent-bit.conf`
- [ ] Create `config/fluent-bit/parsers.conf`
- [ ] Create `config/fluent-bit/extract_container.lua`
- [ ] Create `config/grafana/provisioning/datasources/loki.yaml`
- [ ] Create `config/grafana/provisioning/alerting/telegram.yaml`
- [ ] Create `config/grafana/provisioning/dashboards/dashboards.yaml`
- [ ] Create `config/grafana/provisioning/dashboards/json/agentpod-overview.json`
- [ ] Update `apps/api/src/utils/logger.ts` (structured logging)
- [ ] Update `docker-compose.yml` (add Loki, Fluent Bit, Grafana)
- [ ] Update `.env.example` (add observability vars)
- [ ] Create Telegram bot and get credentials
- [ ] Deploy and verify logs appear in Grafana
- [ ] Configure alert rules
- [ ] Test Telegram notifications

---

## Next Phase

After completing Phase 2, proceed to [Phase 3: CI/CD](./phase-3-ci-cd.md).
