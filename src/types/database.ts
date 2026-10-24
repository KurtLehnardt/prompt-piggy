
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "app_config": {
                  Row: {
                    "key": string,"updated_at": string,"updated_by": string | null,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "key": string,"updated_at"?: string,"updated_by"?: string | null,"value": NonNullable<Json>
                  }
                  Update: {
                    "key"?: string,"updated_at"?: string,"updated_by"?: string | null,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"golden_prompts": {
                  Row: {
                    "attempt_id": string | null,"created_at": string,"id": string,"is_active": boolean,"kind": string,"level_id": number | null,"source": string,"text": string,"text_sha256": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"kind": string,"level_id"?: number | null,"source": string,"text": string,"text_sha256": string
                  }
                  Update: {
                    "attempt_id"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"kind"?: string,"level_id"?: number | null,"source"?: string,"text"?: string,"text_sha256"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "golden_prompts_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    }
                  ]
                },"level_secrets": {
                  Row: {
                    "level_id": number,"payload": NonNullable<Json>,"payload_sha256": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "level_id": number,"payload": NonNullable<Json>,"payload_sha256": string,"updated_at"?: string
                  }
                  Update: {
                    "level_id"?: number,"payload"?: NonNullable<Json>,"payload_sha256"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "level_secrets_level_id_fkey"
      columns: ["level_id"]
isOneToOne: true
      referencedRelation: "levels"
      referencedColumns: ["id"]
    }
                  ]
                },"levels": {
                  Row: {
                    "id": number,"is_active": boolean,"name": string,"slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id": number,"is_active"?: boolean,"name": string,"slug": string
                  }
                  Update: {
                    "id"?: number,"is_active"?: boolean,"name"?: string,"slug"?: string
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"display_name": string,"id": string,"live_hidden": boolean,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name": string,"id": string,"live_hidden"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string,"id"?: string,"live_hidden"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rule_gate_runs": {
                  Row: {
                    "benign_new_blocks": number,"benign_signal_shift_bps": number,"benign_total": number,"breach_regressions": number,"breach_total": number,"drop_codes": (string)[],"dropped_flags": number,"dropped_keywords": number,"failure_codes": (string)[],"finished_at": string | null,"id": string,"loophole_new_blocks": number,"loophole_total": number,"max_validator_ms": number | null,"passed": boolean,"rule_set_id": string,"started_at": string,"traffic_new_blocks": number,"traffic_total": number,"triggering_blocked": boolean | null
                  }
                  ComputedFields: never
                  Insert: {
                    "benign_new_blocks"?: number,"benign_signal_shift_bps"?: number,"benign_total"?: number,"breach_regressions"?: number,"breach_total"?: number,"drop_codes"?: (string)[],"dropped_flags"?: number,"dropped_keywords"?: number,"failure_codes"?: (string)[],"finished_at"?: string | null,"id"?: string,"loophole_new_blocks"?: number,"loophole_total"?: number,"max_validator_ms"?: number | null,"passed": boolean,"rule_set_id": string,"started_at"?: string,"traffic_new_blocks"?: number,"traffic_total"?: number,"triggering_blocked"?: boolean | null
                  }
                  Update: {
                    "benign_new_blocks"?: number,"benign_signal_shift_bps"?: number,"benign_total"?: number,"breach_regressions"?: number,"breach_total"?: number,"drop_codes"?: (string)[],"dropped_flags"?: number,"dropped_keywords"?: number,"failure_codes"?: (string)[],"finished_at"?: string | null,"id"?: string,"loophole_new_blocks"?: number,"loophole_total"?: number,"max_validator_ms"?: number | null,"passed"?: boolean,"rule_set_id"?: string,"started_at"?: string,"traffic_new_blocks"?: number,"traffic_total"?: number,"triggering_blocked"?: boolean | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "rule_gate_runs_rule_set_id_fkey"
      columns: ["rule_set_id"]
isOneToOne: false
      referencedRelation: "rule_sets"
      referencedColumns: ["id"]
    }
                  ]
                },"rule_sets": {
                  Row: {
                    "activated_at": string | null,"created_at": string,"deactivated_at": string | null,"id": string,"level_id": number,"parent_id": string | null,"rejection_code": string | null,"review_status": Database["public"]['Enums']["review_status"],"rules": NonNullable<Json>,"rules_sha256": string,"source": string,"source_attempt_id": string | null,"state": Database["public"]['Enums']["rule_set_state"],"technique": Database["public"]['Enums']["attack_technique"] | null,"version": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "activated_at"?: string | null,"created_at"?: string,"deactivated_at"?: string | null,"id"?: string,"level_id": number,"parent_id"?: string | null,"rejection_code"?: string | null,"review_status"?: Database["public"]['Enums']["review_status"],"rules": NonNullable<Json>,"rules_sha256": string,"source": string,"source_attempt_id"?: string | null,"state"?: Database["public"]['Enums']["rule_set_state"],"technique"?: Database["public"]['Enums']["attack_technique"] | null,"version"?: number | null
                  }
                  Update: {
                    "activated_at"?: string | null,"created_at"?: string,"deactivated_at"?: string | null,"id"?: string,"level_id"?: number,"parent_id"?: string | null,"rejection_code"?: string | null,"review_status"?: Database["public"]['Enums']["review_status"],"rules"?: NonNullable<Json>,"rules_sha256"?: string,"source"?: string,"source_attempt_id"?: string | null,"state"?: Database["public"]['Enums']["rule_set_state"],"technique"?: Database["public"]['Enums']["attack_technique"] | null,"version"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "rule_sets_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rule_sets_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "rule_sets"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "app_config_value_ok":
{ Args: { "p_key": string,"p_value": Json }; Returns: boolean
                           },
"insert_rule_proposal":
{ Args: { "p_level_id": number,"p_parent_id": string,"p_rules": Json,"p_source_attempt_id": string,"p_technique": Database["public"]['Enums']["attack_technique"] }; Returns: string
                           },
"level_secret_payload_ok":
{ Args: { "p": Json }; Returns: boolean
                           },
"promote_rule_set":
{ Args: { "p_rule_set_id": string }; Returns: number
                           },
"reject_rule_set":
{ Args: { "p_needs_review": boolean,"p_rejection_code": string,"p_rule_set_id": string }; Returns: undefined
                           },
"reset_level_rules":
{ Args: { "p_level_id": number }; Returns: string
                           },
"rollback_rule_set":
{ Args: { "p_level_id": number,"p_target_rule_set_id": string }; Returns: string
                           },
"rule_set_payload_ok":
{ Args: { "p": Json }; Returns: boolean
                           }
          }
          Enums: {
            "attack_technique": "roleplay_persona"|"authority_impersonation"|"instruction_override"|"delimiter_injection"|"encoded_smuggling"|"tool_or_mcp_takeover"|"deferred_trigger"|"emotional_social_engineering"|"prompt_extraction"|"multilingual_obfuscation"|"unclassified"|"unknown","review_status": "none"|"needs_review"|"dismissed"|"actioned","rule_set_state": "proposed"|"active"|"superseded"|"rejected"|"rolled_back"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "attack_technique": ["roleplay_persona", "authority_impersonation", "instruction_override", "delimiter_injection", "encoded_smuggling", "tool_or_mcp_takeover", "deferred_trigger", "emotional_social_engineering", "prompt_extraction", "multilingual_obfuscation", "unclassified", "unknown"],"review_status": ["none", "needs_review", "dismissed", "actioned"],"rule_set_state": ["proposed", "active", "superseded", "rejected", "rolled_back"]
          }
        }
} as const
