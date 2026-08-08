export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      sentinel_workspaces: {
        Row: {
          id: string;
          name: string;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_by: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          created_by?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sentinel_workspaces_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      sentinel_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: "analyst" | "manager";
          status: "active" | "pending";
          invited_email: string | null;
          created_at: string;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role: "analyst" | "manager";
          status: "active" | "pending";
          invited_email?: string | null;
          created_at?: string;
        };
        // `role` and `status` are only writable by `service_role` and the member-management
        // RPCs (sentinel_activate_member / sentinel_set_member_role / sentinel_reject_invitation).
        // `authenticated` no longer holds direct UPDATE on either column.
        Update: {
          workspace_id?: string;
          user_id?: string;
          role?: "analyst" | "manager";
          status?: "active" | "pending";
          invited_email?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sentinel_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      sentinel_investigations: {
        Row: {
          id: string;
          workspace_id: string;
          reference: string;
          entity: string;
          owner_id: string | null;
          status: "open" | "review" | "approved" | "closed";
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          reference: string;
          entity: string;
          owner_id?: string | null;
          status?: "open" | "review" | "approved" | "closed";
          created_by: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          reference?: string;
          entity?: string;
          owner_id?: string | null;
          status?: "open" | "review" | "approved" | "closed";
          created_by?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sentinel_investigations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_investigations_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_investigations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      sentinel_uploads: {
        Row: {
          id: string;
          workspace_id: string;
          investigation_id: string;
          storage_path: string;
          original_name: string;
          extension: "csv" | "xls" | "xlsx";
          mime_type: string | null;
          byte_size: number;
          status: "created" | "uploading" | "uploaded" | "processing" | "parsed" | "failed";
          row_count: number;
          warnings: Json;
          error_message: string | null;
          uploaded_by: string;
          created_at: string;
          uploaded_at: string | null;
          processing_started_at: string | null;
          processed_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          investigation_id: string;
          storage_path: string;
          original_name: string;
          extension: "csv" | "xls" | "xlsx";
          mime_type?: string | null;
          byte_size: number;
          status?: "created" | "uploading" | "uploaded" | "processing" | "parsed" | "failed";
          row_count?: number;
          warnings?: Json;
          error_message?: string | null;
          uploaded_by: string;
          created_at?: string;
          uploaded_at?: string | null;
          processing_started_at?: string | null;
          processed_at?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          investigation_id?: string;
          storage_path?: string;
          original_name?: string;
          extension?: "csv" | "xls" | "xlsx";
          mime_type?: string | null;
          byte_size?: number;
          status?: "created" | "uploading" | "uploaded" | "processing" | "parsed" | "failed";
          row_count?: number;
          warnings?: Json;
          error_message?: string | null;
          uploaded_by?: string;
          created_at?: string;
          uploaded_at?: string | null;
          processing_started_at?: string | null;
          processed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sentinel_uploads_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_uploads_investigation_id_fkey";
            columns: ["investigation_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_investigations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_uploads_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      sentinel_import_rows: {
        Row: {
          id: string;
          workspace_id: string;
          investigation_id: string;
          upload_id: string;
          source_row: number;
          entity: string;
          values: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          investigation_id: string;
          upload_id: string;
          source_row: number;
          entity: string;
          values: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          investigation_id?: string;
          upload_id?: string;
          source_row?: number;
          entity?: string;
          values?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sentinel_import_rows_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_import_rows_investigation_id_fkey";
            columns: ["investigation_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_investigations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_import_rows_upload_id_fkey";
            columns: ["upload_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_uploads";
            referencedColumns: ["id"];
          },
        ];
      };
      sentinel_activity_events: {
        Row: {
          id: string;
          workspace_id: string;
          investigation_id: string | null;
          actor_id: string | null;
          event_type:
            | "investigation-created"
            | "upload-created"
            | "parse-started"
            | "parse-completed"
            | "parse-failed"
            | "member-invited"
            | "member-activated"
            | "member-role-changed"
            | "member-invite-rejected";
          rationale: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          investigation_id?: string | null;
          actor_id?: string | null;
          event_type:
            | "investigation-created"
            | "upload-created"
            | "parse-started"
            | "parse-completed"
            | "parse-failed"
            | "member-invited"
            | "member-activated"
            | "member-role-changed"
            | "member-invite-rejected";
          rationale?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          investigation_id?: string | null;
          actor_id?: string | null;
          event_type?:
            | "investigation-created"
            | "upload-created"
            | "parse-started"
            | "parse-completed"
            | "parse-failed"
            | "member-invited"
            | "member-activated"
            | "member-role-changed"
            | "member-invite-rejected";
          rationale?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sentinel_activity_events_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_activity_events_investigation_id_fkey";
            columns: ["investigation_id"];
            isOneToOne: false;
            referencedRelation: "sentinel_investigations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sentinel_activity_events_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
