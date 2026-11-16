/**
 * The persona: every term list the qualification reads.
 *
 * Two stages read it:
 *
 *   CARD   the search result's title, and only that. A title naming a software role
 *          goes on to the lead page; a title naming something else is rejected; no
 *          title at all goes on too, since the lead page may have one.
 *
 *   LEAD   the full profile, against the filters chosen in the popup (filters.js):
 *          years of experience, tech-stack packs, and the "favourite" checks -- plus
 *          the fixed exclusion of cybersecurity backgrounds.
 *
 * Every term is matched as a whole word, case-insensitively; a space matches any run
 * of whitespace. Widening a list here widens the search -- nothing else does.
 */

export const DEFAULT_RULES = {
  /**
   * The title check. A title passes when it names a role below, unless it also names a
   * field that is not software ("Civil Engineer", "Interior Architect").
   *
   * `role_terms` stand on their own. `role_terms_need_software` are too broad on their
   * own -- most consultants and project managers are not in software. On the search
   * card they pass regardless, since a title is too short to tell; on the lead page
   * they need software beside them: a `software_context` word in the title, or a
   * `software_profile_terms` (or tech-stack) term anywhere in the profile.
   */
  role_terms: [
    "engineer", "engineering", "developer", "programmer", "architect",
    "software", "sre", "site reliability", "devops", "cto", "chief technology officer",
    "tech lead", "technical lead", "data scientist", "machine learning",
  ],
  role_terms_need_software: [
    "project manager", "technical project manager", "program manager", "consultant",
  ],
  software_context: [
    "software", "it", "technical", "tech", "technology", "digital", "data", "cloud",
    "web", "app", "application", "applications", "systems", "solutions", "platform",
    "saas", "sap", "salesforce", "erp", "crm", "oracle", "ai", "ml", "devops",
    "agile", "scrum", "blockchain", "iot", "infrastructure", "integration", "dynamics",
  ],
  /**
   * Software, as the rest of a profile says it. Longer and stricter than
   * `software_context`, which is read in a title only: words like "it" and "app" mean
   * nothing in a paragraph of prose.
   */
  software_profile_terms: [
    "software", "software development", "software engineering", "saas", "cloud",
    "devops", "programming", "coding", "api", "apis", "microservices", "kubernetes",
    "docker", "aws", "azure", "gcp", "google cloud", "python", "java", "c#", "golang",
    "javascript", "typescript", "sql", "erp", "sap", "salesforce", "crm",
    "information technology", "it services", "it consulting", "digital transformation",
    "agile", "scrum", "sdlc", "web development", "mobile development", "ci/cd",
  ],
  non_software_fields: [
    "civil", "mechanical", "electrical", "chemical", "structural", "construction",
    "landscape", "interior", "building", "hvac", "petroleum", "mining", "biomedical",
    "manufacturing", "process", "sales", "field service", "marine", "aerospace",
    "automotive", "environmental", "geotechnical", "mep", "plumbing", "piping",
  ],

  /**
   * Excluded wherever it appears in the profile -- titles, headline, About, history,
   * skills -- whatever the popup says.
   */
  exclude_anywhere: ["cybersecurity", "cyber security", "cyber-security"],

  /**
   * Tech stacks: every profile is scored for all three, and the highest score is the
   * person's stack. No single word decides it.
   *
   * Each stack's words come in three tiers:
   *   title  found in the current job title or one held in the last `old_years` years.
   *          Worth `title` points, once per stack however many title words match.
   *   core   anywhere in the profile, `core` points each.
   *   weak   anywhere in the profile, `weak` points each. Words two stacks share are weak
   *          in both, so they never decide between them.
   * A word met only in a job that ended more than `old_years` years ago counts
   * `old_factor` of its worth. An entry that is an array is one word spelled several
   * ways: "ML" and "machine learning" count once.
   *
   * Full-stack is backend AND frontend: it scores only when its own words show both
   * ("full stack", MERN), or when the frontend and the backend words each reach
   * `side_min` points.
   */
  stack_scoring: {
    title: 3, core: 1, weak: 0.5, old_years: 5, old_factor: 0.5, min_points: 2,
    side_min: 1,
  },

  stack_tiers: {
    // No "transformers", "rag", "gpt" or "embeddings": each is as often something else
    // -- power transformers, RAG status reports, partition tables, word embeddings in a
    // linguistics thesis. Mentions of AI itself are weak: anyone can write "AI" in an
    // About; the tools and methods are what show the work.
    ai: {
      title: [
        "ml engineer", "machine learning engineer", "ai engineer", "deep learning engineer",
        "nlp engineer", "computer vision engineer", "mlops engineer", "llm engineer",
        "applied scientist", "ai researcher", "ml researcher", "machine learning researcher",
        "ai scientist", "machine learning scientist",
      ],
      core: [
        "pytorch", "tensorflow", "keras", "jax", "deep learning",
        ["neural network", "neural networks"], "computer vision",
        ["nlp", "natural language processing"],
        ["llm", "llms", "large language model", "large language models"],
        ["fine-tuning", "fine tuning", "finetuning"],
        ["retrieval augmented generation", "retrieval-augmented generation"],
        "langchain", "llamaindex", ["hugging face", "huggingface"], "mlops", "mlflow",
        "kubeflow", "sagemaker", "vertex ai", "reinforcement learning", "model training",
        ["vector database", "vector databases"], "xgboost", "stable diffusion",
      ],
      weak: [
        ["artificial intelligence", "ai"], ["machine learning", "ml"],
        ["generative ai", "genai", "gen ai"], "chatgpt", "openai", "prompt engineering",
        "agentic", ["ai agents", "ai agent"], ["scikit-learn", "sklearn"],
        "pandas", "numpy", "statistics",
      ],
    },
    // Engineering and science, not reporting: SQL and the BI tools alone are an
    // analyst's, and are weak. No bare "analytics": marketing, web and people analytics
    // are not data work.
    data: {
      title: [
        "data engineer", "analytics engineer", "etl developer", "etl engineer",
        "data architect", "data platform engineer", "data warehouse engineer",
        "data warehouse developer", "data scientist",
      ],
      core: [
        ["spark", "pyspark", "apache spark"], "airflow", "dbt", "snowflake", "databricks",
        "bigquery", "redshift", "hadoop", "hive", "flink", "kafka", "aws glue",
        ["azure synapse", "synapse analytics"], ["azure data factory", "data factory"],
        "delta lake", ["etl", "elt"], ["data pipeline", "data pipelines"],
        ["data warehouse", "data warehousing"], ["data lake", "data lakes"], "lakehouse",
        ["data modeling", "data modelling"], "data engineering", "data science",
        "big data", "data platform",
      ],
      weak: [
        "sql", "tableau", "power bi", "looker", "excel", "pandas", "numpy", "statistics",
        "business intelligence", ["data analyst", "data analytics", "data analysis"],
      ],
    },
    // Its own words say both sides at once; `front` and `back` say one side each.
    // No bare "react": in a profile it is as often the verb -- "react to incidents" --
    // as the library, which is named here by its other spellings. No bare "go" either.
    fullstack: {
      title: ["full stack", "full-stack", "fullstack"],
      core: [["full stack", "full-stack", "fullstack"], "mern", "mean stack"],
      weak: [],
      front: {
        title: [
          "frontend", "front end", "front-end", "ui engineer", "ui developer",
          "react developer", "angular developer", "javascript developer",
        ],
        core: [
          ["react.js", "reactjs"], ["next.js", "nextjs"], ["angular", "angularjs"],
          ["vue", "vue.js", "vuejs"], "nuxt", "svelte", "typescript", "redux", "tailwind",
          ["front end", "front-end", "frontend"],
        ],
        weak: [
          "javascript", "html", "css",
          ["web developer", "web development", "web applications"],
        ],
      },
      back: {
        title: [
          "backend", "back end", "back-end", "java developer", ".net developer",
          "php developer", "node.js developer", "python developer",
        ],
        core: [
          ["node.js", "nodejs"], ["express.js", "expressjs"], "nestjs", "django", "flask",
          "fastapi", "ruby on rails", "laravel", "spring boot", ["asp.net", ".net"],
          "graphql", ["rest api", "rest apis", "restful"], "microservices", "php",
          ["back end", "back-end", "backend"],
        ],
        weak: [
          "java", "c#", "golang", "sql", "postgresql", "mysql", "mongodb", "redis",
          "kafka", "docker",
        ],
      },
    },
  },

  /** "Speaking": people whose work involves talking to an audience. */
  speaking: [
    "speaker", "public speaker", "public speaking", "keynote", "keynote speaker",
    "conference speaker", "speaking", "tutor", "tutoring", "teaching", "teacher",
    "teaching assistant", "professor", "assistant professor", "associate professor",
    "adjunct", "lecturer", "instructor", "trainer", "corporate trainer", "educator",
    "consultant", "consulting", "mentor", "mentoring", "coach", "coaching",
    "evangelist", "developer advocate", "devrel", "presenter", "podcast", "podcaster",
    "workshop", "workshops", "webinar", "webinars", "bootcamp", "course creator",
    "youtuber", "content creator", "moderator", "panelist",
  ],

  /**
   * "Big company": famous employers, tech or not. Matched against the companies in the
   * experience history only, so "used Google Cloud" in a description does not count.
   */
  big_companies: [
    "google", "alphabet", "microsoft", "ibm", "amazon", "aws", "amazon web services",
    "apple", "meta", "facebook", "instagram", "whatsapp", "netflix", "oracle", "intel",
    "cisco", "sap", "salesforce", "adobe", "nvidia", "amd", "qualcomm", "tesla",
    "spacex", "uber", "airbnb", "linkedin", "twitter", "x corp", "samsung", "sony",
    "siemens", "philips", "bosch", "general electric", "ge", "hp", "hewlett packard",
    "hewlett packard enterprise", "dell", "vmware", "red hat", "openai", "anthropic",
    "deepmind", "stripe", "paypal", "visa", "mastercard", "american express",
    "spotify", "shopify", "atlassian", "ebay", "booking.com", "expedia", "alibaba",
    "tencent", "baidu", "bytedance", "tiktok", "huawei", "lenovo", "infosys", "tcs",
    "tata consultancy services", "wipro", "accenture", "deloitte", "pwc",
    "pricewaterhousecoopers", "ey", "ernst & young", "kpmg", "mckinsey", "boston consulting group",
    "bcg", "bain", "capgemini", "goldman sachs", "jpmorgan", "jp morgan",
    "jpmorgan chase", "morgan stanley", "citi", "citigroup", "citibank",
    "bank of america", "wells fargo", "barclays", "hsbc", "ubs", "deutsche bank",
    "blackrock", "walmart", "target", "costco", "coca-cola", "pepsico",
    "procter & gamble", "p&g", "unilever", "nestle", "nestlé", "johnson & johnson",
    "pfizer", "novartis", "roche", "boeing", "airbus", "lockheed martin", "ford",
    "general motors", "toyota", "honda", "bmw", "mercedes-benz", "volkswagen",
    "shell", "exxonmobil", "chevron", "bp", "disney", "nike", "mcdonald's",
    "starbucks", "verizon", "at&t", "t-mobile", "comcast", "nokia", "ericsson",
  ],

  /** "Big university": famous universities, matched against education entries only. */
  big_universities: [
    "stanford", "mit", "massachusetts institute of technology", "harvard", "berkeley",
    "uc berkeley", "caltech", "california institute of technology", "princeton", "yale",
    "columbia university", "cornell", "university of pennsylvania", "upenn", "wharton",
    "carnegie mellon", "cmu", "university of chicago", "johns hopkins", "duke",
    "northwestern university", "brown university", "dartmouth", "ucla", "nyu",
    "new york university", "georgia tech", "georgia institute of technology",
    "university of michigan", "uiuc", "university of illinois", "university of washington",
    "university of texas at austin", "ut austin", "university of southern california",
    "usc", "oxford", "university of oxford", "cambridge", "university of cambridge",
    "imperial college", "ucl", "university college london", "london school of economics",
    "lse", "eth zurich", "epfl", "technical university of munich", "tum",
    "university of toronto", "university of waterloo", "mcgill", "university of british columbia",
    "ubc", "national university of singapore", "nus", "nanyang technological university",
    "ntu", "tsinghua", "peking university", "university of tokyo", "kyoto university",
    "seoul national university", "kaist", "iit", "indian institute of technology",
    "iisc", "indian institute of science", "technion", "weizmann", "university of melbourne",
    "university of sydney", "insead", "hec paris", "sorbonne", "karolinska",
  ],

  /**
   * "Degrees": what each selectable degree looks like in an education entry. A master's
   * that is an MBA counts as MBA, not as MS.
   */
  degrees: {
    bs: ["bachelor", "bachelors", "bachelor's", "bs", "b.s", "b.s.", "bsc", "b.sc",
         "b.sc.", "ba", "b.a", "b.a.", "b.e", "b.e.", "beng", "b.eng", "btech", "b.tech",
         "b.tech.", "undergraduate degree"],
    ms: ["master", "masters", "master's", "ms", "m.s", "m.s.", "msc", "m.sc", "m.sc.",
         "meng", "m.eng", "mtech", "m.tech", "m.tech.", "ma", "m.a", "m.a.", "mca"],
    phd: ["phd", "ph.d", "ph.d.", "doctorate", "doctor of philosophy", "dphil", "d.phil"],
    mba: ["mba", "m.b.a", "m.b.a.", "master of business administration", "executive mba",
          "emba"],
  },
};
