/**
 * MultiSelect — dropdown with searchable checkbox list.
 * Used for category multi-selection on Movies/Series pages.
 */

class MultiSelect {
    /**
     * @param {Object} opts
     * @param {string} opts.btnId       trigger button element id
     * @param {string} opts.panelId     dropdown panel element id
     * @param {string} opts.searchId    search input element id
     * @param {string} opts.listId      checkbox list container element id
     * @param {string} opts.allLabel    label when nothing selected ("All Categories")
     * @param {Function} opts.onChange  called with Set of selected values
     */
    constructor(opts) {
        this.btn = document.getElementById(opts.btnId);
        this.panel = document.getElementById(opts.panelId);
        this.searchInput = document.getElementById(opts.searchId);
        this.list = document.getElementById(opts.listId);
        this.allLabel = opts.allLabel || 'All';
        this.onChange = opts.onChange || (() => {});

        this.options = []; // { value, label }
        this.selected = new Set();

        this.init();
    }

    init() {
        this.btn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.panel?.classList.toggle('hidden');
            if (!this.panel?.classList.contains('hidden')) {
                this.searchInput?.focus();
            }
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (this.panel && !this.panel.classList.contains('hidden') &&
                !this.panel.contains(e.target) && e.target !== this.btn) {
                this.panel.classList.add('hidden');
            }
        });

        this.searchInput?.addEventListener('input', () => this.renderList());
        this.searchInput?.addEventListener('click', (e) => e.stopPropagation());

        // All / Clear buttons
        this.panel?.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.dataset.action === 'all') {
                    this.selected = new Set(this.options.map(o => o.value));
                } else {
                    this.selected.clear();
                }
                this.renderList();
                this.updateButton();
                this.onChange(new Set(this.selected));
            });
        });
    }

    /** Replace available options; keeps still-valid selections */
    setOptions(options, { keepSelection = true } = {}) {
        this.options = options;
        if (keepSelection) {
            const valid = new Set(options.map(o => o.value));
            this.selected = new Set([...this.selected].filter(v => valid.has(v)));
        } else {
            this.selected.clear();
        }
        this.renderList();
        this.updateButton();
    }

    setSelected(values) {
        const valid = new Set(this.options.map(o => o.value));
        this.selected = new Set([...values].filter(v => valid.has(v)));
        this.renderList();
        this.updateButton();
    }

    getSelected() {
        return new Set(this.selected);
    }

    renderList() {
        if (!this.list) return;
        const term = MediaUtils.searchableText(this.searchInput?.value || '');
        const filtered = term
            ? this.options.filter(o => MediaUtils.searchableText(o.label).includes(term))
            : this.options;

        if (filtered.length === 0) {
            this.list.innerHTML = '<p class="hint multi-select-empty">No categories found</p>';
            return;
        }

        this.list.innerHTML = filtered.map(o => `
            <label class="multi-select-item">
                <input type="checkbox" value="${MediaUtils.escapeHtml(o.value)}"
                    ${this.selected.has(o.value) ? 'checked' : ''}>
                <span>${MediaUtils.escapeHtml(o.label)}</span>
            </label>
        `).join('');

        this.list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) this.selected.add(cb.value);
                else this.selected.delete(cb.value);
                this.updateButton();
                this.onChange(new Set(this.selected));
            });
        });
    }

    updateButton() {
        if (!this.btn) return;
        if (this.selected.size === 0) {
            this.btn.textContent = this.allLabel;
            this.btn.classList.remove('has-selection');
        } else if (this.selected.size === 1) {
            const value = [...this.selected][0];
            const opt = this.options.find(o => o.value === value);
            this.btn.textContent = opt ? opt.label : this.allLabel;
            this.btn.classList.add('has-selection');
        } else {
            this.btn.textContent = `${this.allLabel.replace('All ', '')} (${this.selected.size})`;
            this.btn.classList.add('has-selection');
        }
    }
}

window.MultiSelect = MultiSelect;
