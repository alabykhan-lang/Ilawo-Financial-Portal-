export type Role = "principal" | "staff";

export type PermissionKey =
  | "record_student_payments"
  | "view_students"
  | "view_own_collections"
  | "view_all_collections"
  | "create_handover"
  | "confirm_handovers"
  | "view_school_reports"
  | "manage_financial_categories"
  | "manage_students"
  | "manage_staff"
  | "principal_dashboard"
  | "personal_business";

export interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  role: Role;
  active: boolean;
  staff_code: string | null;
}

export interface Permission {
  key: PermissionKey;
  label: string;
  description: string;
}

export interface SchoolClass {
  id: string;
  name: string;
  display_order: number;
  active: boolean;
}

export interface AcademicSession {
  id: string;
  name: string;
  starts_on: string | null;
  ends_on: string | null;
  active: boolean;
  is_test: boolean;
}

export interface Term {
  id: string;
  session_id: string;
  name: "First Term" | "Second Term" | "Third Term";
  display_order: number;
  active: boolean;
}

export interface FinancialCategory {
  id: string;
  name: string;
  applicable_to_term: boolean;
  active: boolean;
}

export interface Student {
  id: string;
  admission_no: string;
  full_name: string;
  class_id: string;
  arm: string | null;
  status: "active" | "inactive" | "graduated" | "withdrawn";
  academic_session_id: string;
  class?: SchoolClass;
}

export interface ExpectedCharge {
  id: string;
  category_id: string;
  class_id: string;
  session_id: string;
  term_id: string | null;
  expected_amount: number | string;
  active: boolean;
}

export interface Payment {
  id: string;
  reference_no: string;
  student_id: string;
  class_id: string;
  category_id: string;
  amount_paid: number | string;
  payment_date: string;
  collected_at: string;
  collector_id: string;
  session_id: string;
  term_id: string | null;
  note: string | null;
  status: "posted";
  is_test: boolean;
  is_correction: boolean;
  correction_request_id: string | null;
  origin_payment_id: string | null;
  student?: Pick<Student, "full_name" | "admission_no">;
  class?: Pick<SchoolClass, "name">;
  category?: Pick<FinancialCategory, "name">;
  collector?: Pick<Profile, "full_name">;
  session?: Pick<AcademicSession, "name">;
  term?: Pick<Term, "name"> | null;
}

export interface CorrectionRequest {
  id: string;
  original_payment_id: string;
  action: "reverse" | "correct";
  requested_amount: number | string | null;
  requested_student_id: string | null;
  requested_category_id: string | null;
  reason: string;
  requested_by: string;
  status: "pending" | "approved" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_note: string | null;
  created_at: string;
  requester?: Pick<Profile, "full_name">;
  original_payment?: Payment;
}

export interface Handover {
  id: string;
  staff_id: string;
  total_amount: number | string;
  status: "pending" | "confirmed" | "rejected";
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  decision_note: string | null;
  staff?: Pick<Profile, "full_name">;
  reviewer?: Pick<Profile, "full_name">;
}

export interface HandoverItem {
  id: string;
  handover_id: string;
  payment_id: string;
  amount: number | string;
  is_active: boolean;
  payment?: Payment;
}

export interface PersonalProduct {
  id: string;
  name: string;
  cost_price: number | string;
  selling_price: number | string;
  quantity: number;
  active: boolean;
}

export interface PersonalSale {
  id: string;
  product_id: string;
  quantity: number;
  unit_price: number | string;
  unit_cost: number | string;
  sold_at: string;
  note: string | null;
  product?: Pick<PersonalProduct, "name" | "cost_price">;
}

export interface PersonalExpense {
  id: string;
  description: string;
  amount: number | string;
  expense_date: string;
  note: string | null;
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  action: string;
  record_type: string;
  record_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  actor?: Pick<Profile, "full_name"> | null;
}

export interface PortalData {
  profile: Profile;
  permissions: Permission[];
  classes: SchoolClass[];
  sessions: AcademicSession[];
  terms: Term[];
  categories: FinancialCategory[];
  categoryClasses: Array<{ category_id: string; class_id: string }>;
  students: Student[];
  charges: ExpectedCharge[];
  payments: Payment[];
  corrections: CorrectionRequest[];
  handovers: Handover[];
  handoverItems: HandoverItem[];
  personalProducts: PersonalProduct[];
  personalSales: PersonalSale[];
  personalExpenses: PersonalExpense[];
  auditLogs: AuditLog[];
  staffProfiles: Profile[];
  staffPermissionMap: Record<string, PermissionKey[]>;
}
