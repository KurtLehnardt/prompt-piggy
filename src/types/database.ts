
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
            "admin_actions": {
                  Row: {
                    "action": string,"admin_id": string,"created_at": string,"id": number,"target": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"admin_id": string,"created_at"?: string,"id"?: never,"target"?: string | null
                  }
                  Update: {
                    "action"?: string,"admin_id"?: string,"created_at"?: string,"id"?: never,"target"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"ai_spend": {
                  Row: {
                    "attempt_calls": number,"attempt_reserved_micros": number,"attempt_settled_micros": number,"day": string,"hardening_calls": number,"hardening_reserved_micros": number,"hardening_settled_micros": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_calls"?: number,"attempt_reserved_micros"?: number,"attempt_settled_micros"?: number,"day": string,"hardening_calls"?: number,"hardening_reserved_micros"?: number,"hardening_settled_micros"?: number,"updated_at"?: string
                  }
                  Update: {
                    "attempt_calls"?: number,"attempt_reserved_micros"?: number,"attempt_settled_micros"?: number,"day"?: string,"hardening_calls"?: number,"hardening_reserved_micros"?: number,"hardening_settled_micros"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"app_config": {
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
                },"attempts": {
                  Row: {
                    "canary_leaked": boolean,"cost_micros": number,"crack_event": Database["public"]['Enums']["crack_event"] | null,"cracks_after": number | null,"created_at": string,"error_code": string | null,"finalized_at": string | null,"id": string,"idempotency_key": string,"level_id": number,"outcome": Database["public"]['Enums']["attempt_outcome"],"payout_cents": number,"pig_epoch": number,"price_cents": number,"prompt": string | null,"prompt_chars": number,"prompt_fingerprint": string,"prompt_sha256": string,"refund_cents": number,"refund_withheld": boolean,"reply": string | null,"reserved_micros": number,"rule_set_id": string,"spend_day": string,"technique": Database["public"]['Enums']["attack_technique"] | null,"tool_called": boolean,"tripwire_probability": number | null,"user_id": string,"validator_reasons": (string)[],"validator_signals": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "canary_leaked"?: boolean,"cost_micros"?: number,"crack_event"?: Database["public"]['Enums']["crack_event"] | null,"cracks_after"?: number | null,"created_at"?: string,"error_code"?: string | null,"finalized_at"?: string | null,"id"?: string,"idempotency_key": string,"level_id": number,"outcome"?: Database["public"]['Enums']["attempt_outcome"],"payout_cents"?: number,"pig_epoch": number,"price_cents": number,"prompt"?: string | null,"prompt_chars": number,"prompt_fingerprint": string,"prompt_sha256": string,"refund_cents"?: number,"refund_withheld"?: boolean,"reply"?: string | null,"reserved_micros"?: number,"rule_set_id": string,"spend_day": string,"technique"?: Database["public"]['Enums']["attack_technique"] | null,"tool_called"?: boolean,"tripwire_probability"?: number | null,"user_id": string,"validator_reasons"?: (string)[],"validator_signals"?: (string)[]
                  }
                  Update: {
                    "canary_leaked"?: boolean,"cost_micros"?: number,"crack_event"?: Database["public"]['Enums']["crack_event"] | null,"cracks_after"?: number | null,"created_at"?: string,"error_code"?: string | null,"finalized_at"?: string | null,"id"?: string,"idempotency_key"?: string,"level_id"?: number,"outcome"?: Database["public"]['Enums']["attempt_outcome"],"payout_cents"?: number,"pig_epoch"?: number,"price_cents"?: number,"prompt"?: string | null,"prompt_chars"?: number,"prompt_fingerprint"?: string,"prompt_sha256"?: string,"refund_cents"?: number,"refund_withheld"?: boolean,"reply"?: string | null,"reserved_micros"?: number,"rule_set_id"?: string,"spend_day"?: string,"technique"?: Database["public"]['Enums']["attack_technique"] | null,"tool_called"?: boolean,"tripwire_probability"?: number | null,"user_id"?: string,"validator_reasons"?: (string)[],"validator_signals"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "attempts_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attempts_rule_set_id_fkey"
      columns: ["rule_set_id"]
isOneToOne: false
      referencedRelation: "rule_sets"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attempts_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"blocked_fingerprints": {
                  Row: {
                    "attempt_id": string | null,"created_at": string,"fingerprint": string,"level_id": number
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id"?: string | null,"created_at"?: string,"fingerprint": string,"level_id": number
                  }
                  Update: {
                    "attempt_id"?: string | null,"created_at"?: string,"fingerprint"?: string,"level_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "blocked_fingerprints_attempt_id_fkey"
      columns: ["attempt_id"]
isOneToOne: false
      referencedRelation: "attempts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "blocked_fingerprints_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    }
                  ]
                },"donations": {
                  Row: {
                    "amount_cents": number,"created_at": string,"id": number,"idempotency_key": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_cents": number,"created_at"?: string,"id"?: never,"idempotency_key": string,"user_id": string
                  }
                  Update: {
                    "amount_cents"?: number,"created_at"?: string,"id"?: never,"idempotency_key"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "donations_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"game_state": {
                  Row: {
                    "current_level": number,"id": number,"pig_epoch": number,"total_attempts": number,"total_paid_out_cents": number,"total_wins": number,"treasury_cents": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "current_level"?: number,"id"?: number,"pig_epoch"?: number,"total_attempts"?: number,"total_paid_out_cents"?: number,"total_wins"?: number,"treasury_cents"?: number,"updated_at"?: string
                  }
                  Update: {
                    "current_level"?: number,"id"?: number,"pig_epoch"?: number,"total_attempts"?: number,"total_paid_out_cents"?: number,"total_wins"?: number,"treasury_cents"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "game_state_current_level_fkey"
      columns: ["current_level"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    }
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
      foreignKeyName: "golden_prompts_attempt_fk"
      columns: ["attempt_id"]
isOneToOne: false
      referencedRelation: "attempts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "golden_prompts_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    }
                  ]
                },"hardening_jobs": {
                  Row: {
                    "attempt_id": string,"claim_count": number,"claimed_at": string | null,"created_at": string,"error_code": string | null,"finished_at": string | null,"id": string,"level_id": number,"prompt_sha256": string,"rule_set_id": string | null,"status": string,"trigger": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id": string,"claim_count"?: number,"claimed_at"?: string | null,"created_at"?: string,"error_code"?: string | null,"finished_at"?: string | null,"id"?: string,"level_id": number,"prompt_sha256": string,"rule_set_id"?: string | null,"status"?: string,"trigger": string,"user_id": string
                  }
                  Update: {
                    "attempt_id"?: string,"claim_count"?: number,"claimed_at"?: string | null,"created_at"?: string,"error_code"?: string | null,"finished_at"?: string | null,"id"?: string,"level_id"?: number,"prompt_sha256"?: string,"rule_set_id"?: string | null,"status"?: string,"trigger"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "hardening_jobs_attempt_id_fkey"
      columns: ["attempt_id"]
isOneToOne: true
      referencedRelation: "attempts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "hardening_jobs_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "hardening_jobs_rule_set_id_fkey"
      columns: ["rule_set_id"]
isOneToOne: false
      referencedRelation: "rule_sets"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "hardening_jobs_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"ledger_entries": {
                  Row: {
                    "amount_cents": number,"attempt_id": string | null,"created_at": string,"external_ref": string | null,"from_account": string,"id": number,"kind": string,"to_account": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_cents": number,"attempt_id"?: string | null,"created_at"?: string,"external_ref"?: string | null,"from_account": string,"id"?: never,"kind": string,"to_account": string,"user_id"?: string | null
                  }
                  Update: {
                    "amount_cents"?: number,"attempt_id"?: string | null,"created_at"?: string,"external_ref"?: string | null,"from_account"?: string,"id"?: never,"kind"?: string,"to_account"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    
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
                },"live_feed": {
                  Row: {
                    "amount_cents": number | null,"created_at": string,"event_type": string,"id": number,"level_id": number | null,"outcome": Database["public"]['Enums']["attempt_outcome"] | null,"player_id": string | null,"rule_version": number | null,"technique": Database["public"]['Enums']["attack_technique"] | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_cents"?: number | null,"created_at"?: string,"event_type": string,"id"?: never,"level_id"?: number | null,"outcome"?: Database["public"]['Enums']["attempt_outcome"] | null,"player_id"?: string | null,"rule_version"?: number | null,"technique"?: Database["public"]['Enums']["attack_technique"] | null
                  }
                  Update: {
                    "amount_cents"?: number | null,"created_at"?: string,"event_type"?: string,"id"?: never,"level_id"?: number | null,"outcome"?: Database["public"]['Enums']["attempt_outcome"] | null,"player_id"?: string | null,"rule_version"?: number | null,"technique"?: Database["public"]['Enums']["attack_technique"] | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "live_feed_level_id_fkey"
      columns: ["level_id"]
isOneToOne: false
      referencedRelation: "levels"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "live_feed_player_id_fkey"
      columns: ["player_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
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
                },"rate_limits": {
                  Row: {
                    "bucket": string,"tokens": number,"updated_at": string,"user_id": string,"window_day": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bucket": string,"tokens": number,"updated_at"?: string,"user_id": string,"window_day"?: string | null
                  }
                  Update: {
                    "bucket"?: string,"tokens"?: number,"updated_at"?: string,"user_id"?: string,"window_day"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "rate_limits_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
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
    },{
      foreignKeyName: "rule_sets_source_attempt_fk"
      columns: ["source_attempt_id"]
isOneToOne: false
      referencedRelation: "attempts"
      referencedColumns: ["id"]
    }
                  ]
                },"wallets": {
                  Row: {
                    "aura_bps": number | null,"balance_cents": number,"crack_count": number,"created_at": string,"in_flight_attempt_id": string | null,"last_seen_at": string | null,"total_attempts": number,"total_donated_cents": number,"total_wins": number,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "aura_bps"?: never,"balance_cents"?: number,"crack_count"?: number,"created_at"?: string,"in_flight_attempt_id"?: string | null,"last_seen_at"?: string | null,"total_attempts"?: number,"total_donated_cents"?: number,"total_wins"?: number,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "aura_bps"?: never,"balance_cents"?: number,"crack_count"?: number,"created_at"?: string,"in_flight_attempt_id"?: string | null,"last_seen_at"?: string | null,"total_attempts"?: number,"total_donated_cents"?: number,"total_wins"?: number,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wallets_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
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
"get_level_status":
{ Args: Record<PropertyKey, never>; Returns: {
              "active_version": number,"last_hardened_at": string,"level_id": number,"name": string
            }[]
                           },
"get_live_players":
{ Args: { "p_known_hash"?: string,"p_limit"?: number,"p_window_seconds"?: number }; Returns: {
              "list_hash": string,"players": Json
            }[]
                           },
"get_public_config":
{ Args: Record<PropertyKey, never>; Returns: {
              "attempt_price_cents": number,"attempts_enabled": boolean,"repair_price_cents": number
            }[]
                           },
"insert_rule_proposal":
{ Args: { "p_level_id": number,"p_parent_id": string,"p_rules": Json,"p_source_attempt_id": string,"p_technique": Database["public"]['Enums']["attack_technique"] }; Returns: string
                           },
"level_secret_payload_ok":
{ Args: { "p": Json }; Returns: boolean
                           },
"presence_ping":
{ Args: { "p_known_hash"?: string,"p_limit"?: number,"p_user_id": string,"p_window_seconds"?: number }; Returns: {
              "list_hash": string,"players": Json
            }[]
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
            "attack_technique": "roleplay_persona"|"authority_impersonation"|"instruction_override"|"delimiter_injection"|"encoded_smuggling"|"tool_or_mcp_takeover"|"deferred_trigger"|"emotional_social_engineering"|"prompt_extraction"|"multilingual_obfuscation"|"unclassified"|"unknown","attempt_outcome": "pending"|"win"|"late_win"|"fail"|"blocked"|"leak_blocked"|"error","crack_event": "none"|"crack"|"shatter"|"repaired","review_status": "none"|"needs_review"|"dismissed"|"actioned","rule_set_state": "proposed"|"active"|"superseded"|"rejected"|"rolled_back"
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
            "attack_technique": ["roleplay_persona", "authority_impersonation", "instruction_override", "delimiter_injection", "encoded_smuggling", "tool_or_mcp_takeover", "deferred_trigger", "emotional_social_engineering", "prompt_extraction", "multilingual_obfuscation", "unclassified", "unknown"],"attempt_outcome": ["pending", "win", "late_win", "fail", "blocked", "leak_blocked", "error"],"crack_event": ["none", "crack", "shatter", "repaired"],"review_status": ["none", "needs_review", "dismissed", "actioned"],"rule_set_state": ["proposed", "active", "superseded", "rejected", "rolled_back"]
          }
        }
} as const
