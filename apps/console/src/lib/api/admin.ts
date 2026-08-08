/**
 * Admin API Client
 * 
 * Frontend client for admin functionality. Makes direct HTTP calls to the
 * Management API using the auth token from Tauri storage.
 */

import type {
  AdminUserView,
  AdminStats,
  UserResourceLimits,
  UpdateUserResourceLimitsInput,
  ListUsersResponse,
  GetUserResponse,
  GetUserLimitsResponse,
  AuditLogResponse,
  UserRole,
} from "@agentpod/types";
import { handleUnauthorized } from "./client";
// =============================================================================
// API Client Helper
// =============================================================================

/**
 * Get the base URL for API calls
 */
function getApiBaseUrl(): string {
  // Mirror api/client.ts: resolve the hub URL from the saved connection or the
  // build-time PUBLIC_HUB_URL. (Previously used Tauri getConnectionStatus, which
  // is undefined in the web build — calling it threw "reading 'invoke'" and broke
  // every admin API call, so the admin guard denied access even to real admins.)
  const stored =
    typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
  return stored ?? import.meta.env.PUBLIC_HUB_URL ?? "http://localhost:3001";
}

/**
 * Make an authenticated API request
 */
async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  // Auth is via the session cookie (credentials: "include"), same as api/client.ts.

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (response.status === 401) {
    handleUnauthorized();
    throw new Error(`API Error: ${response.status}`);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMessage: string;

    try {
      const parsed = JSON.parse(errorBody);
      errorMessage = parsed.message || parsed.error || `API Error: ${response.status}`;
    } catch {
      errorMessage = errorBody || `API Error: ${response.status}`;
    }

    throw new Error(errorMessage);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

// =============================================================================
// User Management
// =============================================================================

/**
 * List users options
 */
export interface ListUsersOptions {
  search?: string;
  role?: UserRole;
  banned?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: "email" | "name" | "createdAt" | "role";
  sortDirection?: "asc" | "desc";
}

/**
 * List all users (admin only)
 */
export async function listUsers(options: ListUsersOptions = {}): Promise<ListUsersResponse> {
  const params = new URLSearchParams();
  
  if (options.search) params.set("search", options.search);
  if (options.role) params.set("role", options.role);
  if (options.banned !== undefined) params.set("banned", String(options.banned));
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  if (options.sortBy) params.set("sortBy", options.sortBy);
  if (options.sortDirection) params.set("sortDirection", options.sortDirection);

  const queryString = params.toString();
  const path = queryString ? `/api/admin/users?${queryString}` : "/api/admin/users";
  
  return apiRequest<ListUsersResponse>(path);
}

/**
 * Get a user by ID (admin only)
 */
export async function getUser(userId: string): Promise<GetUserResponse> {
  return apiRequest<GetUserResponse>(`/api/admin/users/${userId}`);
}

/**
 * Ban a user (admin only)
 */
export async function banUser(userId: string, reason: string): Promise<AdminUserView> {
  const response = await apiRequest<{ user: AdminUserView }>(
    `/api/admin/users/${userId}/ban`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    }
  );
  return response.user;
}

/**
 * Unban a user (admin only)
 */
export async function unbanUser(userId: string): Promise<AdminUserView> {
  const response = await apiRequest<{ user: AdminUserView }>(
    `/api/admin/users/${userId}/unban`,
    {
      method: "POST",
    }
  );
  return response.user;
}

/**
 * Update user role (admin only)
 */
export async function updateUserRole(userId: string, role: UserRole): Promise<AdminUserView> {
  const response = await apiRequest<{ user: AdminUserView }>(
    `/api/admin/users/${userId}/role`,
    {
      method: "PUT",
      body: JSON.stringify({ role }),
    }
  );
  return response.user;
}

// =============================================================================
// Resource Limits
// =============================================================================

/**
 * Get user resource limits (admin only)
 */
export async function getUserLimits(userId: string): Promise<GetUserLimitsResponse> {
  return apiRequest<GetUserLimitsResponse>(`/api/admin/users/${userId}/limits`);
}

/**
 * Update user resource limits (admin only)
 */
export async function updateUserLimits(
  userId: string,
  limits: UpdateUserResourceLimitsInput
): Promise<UserResourceLimits> {
  const response = await apiRequest<{ limits: UserResourceLimits }>(
    `/api/admin/users/${userId}/limits`,
    {
      method: "PUT",
      body: JSON.stringify(limits),
    }
  );
  return response.limits;
}

// =============================================================================
// Statistics & Audit Log
// =============================================================================

/**
 * Get admin statistics (admin only)
 */
export async function getAdminStats(): Promise<AdminStats> {
  const response = await apiRequest<{ stats: AdminStats }>("/api/admin/stats");
  return response.stats;
}

/**
 * Audit log options
 */
export interface AuditLogOptions {
  limit?: number;
  offset?: number;
  userId?: string;
  action?: string;
}

/**
 * Get audit log (admin only)
 */
export async function getAuditLog(options: AuditLogOptions = {}): Promise<AuditLogResponse> {
  const params = new URLSearchParams();
  
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  if (options.userId) params.set("userId", options.userId);
  if (options.action) params.set("action", options.action);

  const queryString = params.toString();
  const path = queryString ? `/api/admin/audit-log?${queryString}` : "/api/admin/audit-log";
  
  return apiRequest<AuditLogResponse>(path);
}

// =============================================================================
// Current User Admin Check
// =============================================================================

/**
 * Check if current user is admin
 * This can be used to determine if admin UI should be shown
 */
export async function checkIsAdmin(): Promise<boolean> {
  try {
    // Try to fetch admin stats - this will fail if not admin
    await getAdminStats();
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Settings Management
// =============================================================================

/**
 * Get signup status
 */
export async function getSignupStatus(): Promise<{ enabled: boolean }> {
  return apiRequest<{ enabled: boolean }>("/api/admin/settings/signup");
}

/**
 * Enable public signup
 */
export async function enableSignup(): Promise<{ enabled: boolean }> {
  const response = await apiRequest<{ enabled: boolean }>(
    "/api/admin/settings/signup/enable",
    { method: "POST" }
  );
  return response;
}

/**
 * Disable public signup
 */
export async function disableSignup(): Promise<{ enabled: boolean }> {
  const response = await apiRequest<{ enabled: boolean }>(
    "/api/admin/settings/signup/disable",
    { method: "POST" }
  );
  return response;
}

// =============================================================================
// User Creation
// =============================================================================

/**
 * Create a new user (admin only)
 */
export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  role?: UserRole;
}

export async function createUser(input: CreateUserInput): Promise<AdminUserView> {
  const response = await apiRequest<{ user: AdminUserView }>(
    "/api/admin/users",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return response.user;
}

// =============================================================================
// Agent Catalog Management (Admin)
// =============================================================================

export type AgentStatus = "active" | "deprecated" | "hidden" | "pending_review";
export type AgentSquad = "orchestration" | "development" | "product" | "operations" | "security" | "data";
export type AgentTier = "central" | "foundation" | "specialized" | "premium";

export interface AgentCatalogItem {
  id: string;
  slug: string;
  name: string;
  role: string;
  emoji: string | null;
  description: string | null;
  squad: AgentSquad;
  tier: AgentTier | null;
  isBuiltin: boolean;
  isPremium: boolean;
  isDefault: boolean;
  status: AgentStatus;
  installCount: number;
  ratingAvg: number | null;
}

export interface AgentFullDetails extends AgentCatalogItem {
  tags: string[] | null;
  category: string | null;
  config: Record<string, unknown>;
  opencodeContent: string;
  publisherId: string | null;
  publisherName: string | null;
  priceMonthly: number | null;
  priceYearly: number | null;
  ratingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCatalogResponse {
  agents: AgentCatalogItem[];
  bySquad: Record<AgentSquad, AgentCatalogItem[]>;
}

export interface UpdateAgentInput {
  name?: string;
  role?: string;
  emoji?: string;
  description?: string;
  squad?: AgentSquad;
  tier?: AgentTier;
  tags?: string[];
  category?: string;
  isDefault?: boolean;
  isPremium?: boolean;
  status?: AgentStatus;
  config?: Record<string, unknown>;
  opencodeContent?: string;
}

export async function getAgentCatalog(): Promise<AgentCatalogResponse> {
  return apiRequest<AgentCatalogResponse>("/api/v2/agents/catalog");
}

export async function getAgentById(agentId: string): Promise<{ agent: AgentFullDetails }> {
  return apiRequest<{ agent: AgentFullDetails }>(`/api/v2/agents/catalog/id/${agentId}`);
}

export async function updateAgentCatalogItem(
  agentId: string,
  updates: UpdateAgentInput
): Promise<{ agent: AgentFullDetails }> {
  return apiRequest<{ agent: AgentFullDetails }>(
    `/api/v2/agents/catalog/${agentId}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    }
  );
}
