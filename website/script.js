const pipelineData = {
  "full-with-audit": {
    kicker: "6 phases",
    title: "Full with audit",
    description:
      "Complete reverse-engineering with a defect triage pass before porting and reimplementation planning.",
    phases: [
      "Architecture",
      "Defect scan",
      "Contracts",
      "Protocols",
      "Porting",
      "Reimplementation spec",
    ],
    note: "Best when you need a reusable understanding bundle before maintaining, porting, or rebuilding a system.",
  },
  full: {
    kicker: "5 phases",
    title: "Full",
    description:
      "A full understanding and reimplementation workflow without the dedicated defect-scan phase.",
    phases: ["Architecture", "Contracts", "Protocols", "Porting", "Reimplementation spec"],
    note: "A good fit when porting matters more than auditing existing bugs.",
  },
  "defect-scan": {
    kicker: "2 phases",
    title: "Defect scan",
    description:
      "A maintenance-oriented pass that maps the system and then hunts for correctness, reliability, security, and environment defects.",
    phases: ["Architecture", "Defect scan"],
    note: "Use this when the goal is triage and cleanup rather than a full rewrite plan.",
  },
  lite: {
    kicker: "3 phases",
    title: "Lite",
    description:
      "A focused behavior-recovery workflow for understanding how a system works without producing the porting bundle.",
    phases: ["Architecture", "Contracts", "Protocols"],
    note: "The fastest option that still leaves you with durable product and protocol knowledge.",
  },
  "architecture-only": {
    kicker: "1 phase",
    title: "Architecture only",
    description:
      "A quick structural pass that documents system intent, layers, public surfaces, and runtime shape.",
    phases: ["Architecture"],
    note: "Ideal as a low-cost first pass when you only need to orient yourself.",
  },
};

const pipelineTabs = document.querySelectorAll(".pipeline-tab");
const copyButtons = document.querySelectorAll(".copy-button");
const navToggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector(".nav-links");
const copyStatus = document.querySelector("#copy-status");

const pipelineKicker = document.querySelector("#pipeline-kicker");
const pipelineTitle = document.querySelector("#pipeline-title");
const pipelineDescription = document.querySelector("#pipeline-description");
const pipelinePhases = document.querySelector("#pipeline-phases");
const pipelineNote = document.querySelector("#pipeline-note");

function updatePipeline(key) {
  const pipeline = pipelineData[key];
  if (!pipeline) return;

  pipelineKicker.textContent = pipeline.kicker;
  pipelineTitle.textContent = pipeline.title;
  pipelineDescription.textContent = pipeline.description;
  pipelinePhases.innerHTML = pipeline.phases.map((phase) => `<li>${phase}</li>`).join("");
  pipelineNote.textContent = pipeline.note;

  pipelineTabs.forEach((tab) => {
    const isActive = tab.dataset.pipeline === key;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
}

pipelineTabs.forEach((tab) => {
  tab.addEventListener("click", () => updatePipeline(tab.dataset.pipeline));
});

copyButtons.forEach((button) => {
  button.dataset.resetLabel = button.textContent.trim();
  button.addEventListener("click", async () => {
    const copyValue = button.dataset.copy;
    if (!copyValue) return;

    try {
      await navigator.clipboard.writeText(copyValue);
      button.textContent = "Copied";
      copyStatus.textContent = "Copied to clipboard.";
      window.setTimeout(() => {
        button.textContent = button.dataset.resetLabel || "Copy";
      }, 1600);
    } catch (_error) {
      copyStatus.textContent = "Clipboard copy was blocked.";
    }
  });
});

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    const isOpen = navLinks.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.2 }
);

document.querySelectorAll("[data-reveal]").forEach((node) => observer.observe(node));
updatePipeline("full-with-audit");
