from pathlib import Path

portal = Path("components/PrincipalPortalV4.tsx")
text = portal.read_text()

replacements = [
    (
        '''            {[...s.ip.map((p) => ({ ...p, who: d.students.find((x) => x.id === p.student_id)?.full_name || "Student" })), ...s.ep.map((p) => ({ ...p, who: d.external.find((x) => x.id === p.external_candidate_id)?.full_name || "External candidate" }))]\n              .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)))''',
        '''            {([...s.ip.map((p: R) => ({ ...p, who: d.students.find((x) => x.id === p.student_id)?.full_name || "Student" })), ...s.ep.map((p: R) => ({ ...p, who: d.external.find((x) => x.id === p.external_candidate_id)?.full_name || "External candidate" }))] as R[])\n              .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)))''',
        "recent-payment typing",
    ),
    (
        '''            {mixed ? (\n              <>\n                <button><strong>{s.internalCount}</strong><span>Internal</span></button>\n                <button><strong>{s.externalCount}</strong><span>External</span></button>\n                <button><strong>{s.fully}</strong><span>Fully paid</span></button>\n              </>\n            ) : (''',
        '''            {mixed ? (\n              <>\n                <button><strong>{s.internalCount}</strong><span>Internal</span></button>\n                <button><strong>{s.externalCount}</strong><span>External</span></button>\n                <button><strong>{s.fully}</strong><span>Fully paid</span></button>\n                <button><strong>{s.part}</strong><span>Partly paid</span></button>\n                <button><strong>{s.unpaid}</strong><span>Not paid</span></button>\n              </>\n            ) : (''',
        "mixed status counts",
    ),
    (
        '''  const examStudents = d.students.filter((s) => s.academic_session_id === session && (!examClass || s.class_id === examClass));\n  const registeredIds = new Set(d.candidates.filter((x) => x.category_id === examCat && x.session_id === session).map((x) => x.student_id));''',
        '''  const examEligibleClassIds = new Set(d.categoryClasses.filter((x) => x.category_id === examCat).map((x) => x.class_id));\n  const examStudents = d.students.filter(\n    (s) => s.academic_session_id === session && (!examCat || examEligibleClassIds.has(s.class_id)) && (!examClass || s.class_id === examClass),\n  );\n  const registeredIds = new Set(d.candidates.filter((x) => x.category_id === examCat && x.session_id === session).map((x) => x.student_id));''',
        "WAEC/NECO eligible students",
    ),
    (
        '''        <div className="table-scroll"><table><thead><tr><th>Category</th><th>Candidates / Students</th><th>Collected</th><th>Expenses</th><th>Net balance</th></tr></thead><tbody>{rows.map(({ c, s }) => <tr key={c.id}><td><strong>{categoryName(c)}</strong></td><td>{isMixed(c) ? `${s.internalCount} internal · ${s.externalCount} external` : `${s.internalCount} internal`}</td><td>{naira(s.collected)}</td><td>{naira(s.spent)}</td><td><strong>{naira(s.collected - s.spent)}</strong></td></tr>)}</tbody></table></div>''',
        '''        <div className="table-scroll"><table><thead><tr><th>Category</th><th>Candidates / Students</th><th>Payment status</th><th>Collected</th><th>Expenses</th><th>Net balance</th></tr></thead><tbody>{rows.map(({ c, s }) => <tr key={c.id}><td><strong>{categoryName(c)}</strong></td><td>{isMixed(c) ? `${s.internalCount} internal · ${s.externalCount} external` : `${s.internalCount} internal`}</td><td>{s.fully} full · {s.part} part · {s.unpaid} unpaid</td><td>{naira(s.collected)}</td><td>{naira(s.spent)}</td><td><strong>{naira(s.collected - s.spent)}</strong></td></tr>)}</tbody></table></div>''',
        "report payment status",
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f"Repair target not found: {label}")
    text = text.replace(old, new, 1)

portal.write_text(text)

config = Path("next.config.ts")
ctext = config.read_text()
old = '''  poweredByHeader: false,\n  typescript: {\n    ignoreBuildErrors: true,\n  },'''
new = '''  poweredByHeader: false,'''
if old not in ctext:
    raise SystemExit("Repair target not found: TypeScript bypass")
config.write_text(ctext.replace(old, new, 1))
