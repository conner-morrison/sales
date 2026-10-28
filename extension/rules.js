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

  /** Tech-stack packs, one per checkbox. A ticked pack passes on any one of its terms. */
  stacks: {
    ai: [
      "artificial intelligence", "ai", "machine learning", "ml", "deep learning",
      "llm", "llms", "large language model", "large language models", "generative ai",
      "genai", "gen ai", "nlp", "natural language processing", "computer vision",
      "neural network", "neural networks", "pytorch", "tensorflow", "keras",
      "hugging face", "huggingface", "transformers", "langchain", "llamaindex",
      "openai", "gpt", "chatgpt", "rag", "retrieval augmented generation",
      "prompt engineering", "mlops", "reinforcement learning", "scikit-learn",
      "sklearn", "ai engineer", "ml engineer", "vector database", "embeddings",
      "fine-tuning", "fine tuning", "stable diffusion", "agentic", "ai agents",
    ],
    fullstack: [
      "full stack", "full-stack", "fullstack", "front end", "front-end", "frontend",
      "back end", "back-end", "backend", "react", "react.js", "reactjs", "next.js",
      "nextjs", "angular", "angularjs", "vue", "vue.js", "vuejs", "nuxt", "svelte",
      "javascript", "typescript", "node.js", "nodejs", "express.js", "expressjs",
      "nestjs", "django", "flask", "fastapi", "ruby on rails", "laravel", "php",
      "spring boot", "asp.net", ".net", "graphql", "rest api", "restful", "html",
      "css", "tailwind", "mongodb", "postgresql", "mysql", "web developer",
      "web development", "web applications", "mern", "mean stack", "redux",
    ],
    data: [
      "data engineer", "data engineering", "data scientist", "data science",
      "data analyst", "data analytics", "analytics", "big data", "etl", "elt",
      "data pipeline", "data pipelines", "data warehouse", "data warehousing",
      "data lake", "lakehouse", "data modeling", "spark", "pyspark", "apache spark",
      "hadoop", "kafka", "airflow", "dbt", "snowflake", "databricks", "bigquery",
      "redshift", "sql", "tableau", "power bi", "looker", "pandas", "numpy",
      "statistics", "business intelligence", "bi developer", "data platform",
    ],
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
