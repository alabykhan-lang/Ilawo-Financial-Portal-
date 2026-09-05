from pathlib import Path

portal = Path("components/PrincipalPortalV4.tsx")
text = portal.read_text()

replacements = [
    (
        '''  let expected = 0;\n  let fully = 0;\n  let part = 0;\n  let unpaid = 0;\n  internal.forEach((s) => {''',
        '''  let expected = 0;\n  let fully = 0;\n  let part = 0;\n  let unpaid = 0;\n  const statusRows: R[] = [];\n  internal.forEach((s) => {''',
        "status row accumulator",
    ),
    (
        '''    const got = paid.get(s.id) || 0;\n    if (got >= due) fully++;\n    else if (got > 0) part++;\n    else unpaid++;\n  });''',
        '''    const got = paid.get(s.id) || 0;\n    const status = got >= due ? "full" : got > 0 ? "part" : "unpaid";\n    statusRows.push({ id: `internal-${s.id}`, name: s.full_name, admission_no: s.admission_no, type: "Internal", paid: got, due, status });\n    if (status === "full") fully++;\n    else if (status === "part") part++;\n    else unpaid++;\n  });''',
        "internal status rows",
    ),
    (
        '''    const got = extPaid.get(s.id) || 0;\n    if (got >= due) extFully++;\n    else if (got > 0) extPart++;\n    else extUnpaid++;\n  });''',
        '''    const got = extPaid.get(s.id) || 0;\n    const status = got >= due ? "full" : got > 0 ? "part" : "unpaid";\n    statusRows.push({ id: `external-${s.id}`, name: s.full_name, admission_no: s.class_level || "External", type: "External", paid: got, due, status });\n    if (status === "full") extFully++;\n    else if (status === "part") extPart++;\n    else extUnpaid++;\n  });''',
        "external status rows",
    ),
    (
        '''    externalCount: ext.length,\n  };''',
        '''    externalCount: ext.length,\n    statusRows: statusRows.sort((a, b) => String(a.name).localeCompare(String(b.name))),\n  };''',
        "status rows return",
    ),
    (
        '''          {mixed && <p className="helper-line">Only WAEC and NECO support both internal and external candidates. Their money is combined, while candidate counts remain separate.</p>}\n          <div className="quick-actions" style={{ marginTop: 18 }}>''',
        '''          {mixed && <p className="helper-line">Only WAEC and NECO support both internal and external candidates. Their money is combined, while candidate counts remain separate.</p>}\n          {s.statusRows.length > 0 && (\n            <details style={{ marginTop: 18 }}>\n              <summary className="text-button" style={{ cursor: "pointer" }}>View names and payment status ({s.statusRows.length})</summary>\n              <div className="simple-list" style={{ marginTop: 12 }}>\n                {s.statusRows.map((row: R) => (\n                  <div className="simple-list-row" key={row.id}>\n                    <div><strong>{row.name}</strong><span>{row.type}{row.admission_no ? ` · ${row.admission_no}` : ""} · Paid {naira(row.paid)} of {naira(row.due)}</span></div>\n                    <Badge tone={row.status === "full" ? "success" : row.status === "part" ? "warning" : "danger"}>{row.status === "full" ? "Fully paid" : row.status === "part" ? "Partly paid" : "Not paid"}</Badge>\n                  </div>\n                ))}\n              </div>\n            </details>\n          )}\n          <div className="quick-actions" style={{ marginTop: 18 }}>''',
        "category payment names",
    ),
    (
        '''      <section className="panel">\n        <div className="table-scroll"><table><thead><tr><th>Category</th><th>Candidates / Students</th><th>Payment status</th><th>Collected</th><th>Expenses</th><th>Net balance</th></tr></thead><tbody>{rows.map(({ c, s }) => <tr key={c.id}><td><strong>{categoryName(c)}</strong></td><td>{isMixed(c) ? `${s.internalCount} internal · ${s.externalCount} external` : `${s.internalCount} internal`}</td><td>{s.fully} full · {s.part} part · {s.unpaid} unpaid</td><td>{naira(s.collected)}</td><td>{naira(s.spent)}</td><td><strong>{naira(s.collected - s.spent)}</strong></td></tr>)}</tbody></table></div>\n      </section>\n    </div>''',
        '''      <section className="panel">\n        <div className="table-scroll"><table><thead><tr><th>Category</th><th>Candidates / Students</th><th>Payment status</th><th>Collected</th><th>Expenses</th><th>Net balance</th></tr></thead><tbody>{rows.map(({ c, s }) => <tr key={c.id}><td><strong>{categoryName(c)}</strong></td><td>{isMixed(c) ? `${s.internalCount} internal · ${s.externalCount} external` : `${s.internalCount} internal`}</td><td>{s.fully} full · {s.part} part · {s.unpaid} unpaid</td><td>{naira(s.collected)}</td><td>{naira(s.spent)}</td><td><strong>{naira(s.collected - s.spent)}</strong></td></tr>)}</tbody></table></div>\n      </section>\n      {cat && rows[0]?.s.statusRows.length > 0 && (\n        <section className="panel">\n          <div className="panel-heading"><div><span className="section-kicker">PAYMENT STATUS NAMES</span><h2>{categoryName(rows[0].c)}</h2></div></div>\n          <div className="simple-list">{rows[0].s.statusRows.map((row: R) => <div className="simple-list-row" key={row.id}><div><strong>{row.name}</strong><span>{row.type}{row.admission_no ? ` · ${row.admission_no}` : ""} · {naira(row.paid)} / {naira(row.due)}</span></div><Badge tone={row.status === "full" ? "success" : row.status === "part" ? "warning" : "danger"}>{row.status === "full" ? "Fully paid" : row.status === "part" ? "Partly paid" : "Not paid"}</Badge></div>)}</div>\n        </section>\n      )}\n    </div>''',
        "report status names",
    ),
    (
        '''      <section className="panel">\n        <div className="panel-heading"><div><span className="section-kicker">CHATGPT COMMAND CENTER</span><h2>Agent-ready portal</h2></div><Badge tone="info">Backend prepared</Badge></div>\n        <p className="helper-line">The portal exposes a secure command-center API/MCP layer so the Principal can query finances and perform approved actions from ChatGPT. Connection availability depends on the ChatGPT plan; the portal itself remains the source of truth and all writes still pass through Supabase RLS and audit rules.</p>\n      </section>''',
        '''      <section className="panel">\n        <div className="panel-heading"><div><span className="section-kicker">PERSONAL BUSINESS</span><h2>Private small-trade record</h2></div><Badge tone="neutral">Separate</Badge></div>\n        <p className="helper-line">Products, stock, sales and private business expenses stay completely separate from school collections.</p>\n        <a className="button ghost" href="/personal-business">Open Personal Business →</a>\n      </section>\n\n      <section className="panel">\n        <div className="panel-heading"><div><span className="section-kicker">CHATGPT COMMAND CENTER</span><h2>Agent-ready portal</h2></div><Badge tone="info">Backend prepared</Badge></div>\n        <p className="helper-line">The portal exposes a secure command-center API/MCP layer so the Principal can query finances and perform approved actions from ChatGPT. Connection availability depends on the ChatGPT plan; the portal itself remains the source of truth and all writes still pass through Supabase RLS and audit rules.</p>\n      </section>''',
        "Personal Business settings link",
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f"Finish target not found: {label}")
    text = text.replace(old, new, 1)

portal.write_text(text)
