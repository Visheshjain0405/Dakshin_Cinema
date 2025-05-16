const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");
const cors = require("cors");
const mongoose = require("mongoose");
const winston = require("winston");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Setup logging with Winston
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console(),
  ],
});

// Email setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendErrorEmail = async (errorMessage) => {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: "visheshj865@gmail.com",
      subject: "Error in Article Generation",
      text: `An error occurred: ${errorMessage}`,
    });
    logger.info("Error email sent successfully");
  } catch (error) {
    logger.error("Failed to send error email:", error);
  }
};

// AI keys
const OPENROUTER_API_KEYS = [
  "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",
  "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",
  "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",
  "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",
];

// Configuration from environment variables
const MONGO_URI = process.env.MONGO_URI;
const WP_URL = process.env.WP_URL;
const WP_USERNAME = process.env.WP_USERNAME;
const WP_PASSWORD = process.env.WP_PASSWORD;

// Mongoose schema
const articleSchema = new mongoose.Schema({
  title: String,
  generatedTitle: String,
  link: { type: String, unique: true },
  source: String,
  fullContent: String,
  regeneratedContent: String,
  wordCount: Number,
  wordpressPostId: String,
  wordpressPostUrl: String,
  seoKeywords: [String],
  createdAt: { type: Date, default: Date.now },
});
const Article = mongoose.model("Article", articleSchema);

// Connect to MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => logger.info("✅ MongoDB Connected"))
  .catch((err) => {
    logger.error("❌ MongoDB Connection Error:", err);
    sendErrorEmail(`MongoDB Connection Error: ${err.message}`);
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async (fn, retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      logger.info(`Retrying (${i + 1}/${retries})...`);
      await sleep(delay);
    }
  }
};

// Fetch articles from source
const fetchArticlesFromSource = async () => {
  try {
    const sites = [
      {
        url: "https://www.123telugu.com/category/mnews",
        selector: ".pcsl-title",
        name: "123Telugu",
      },
    ];

    let allArticles = [];
    for (const site of sites) {
      const { data } = await axios.get(site.url);
      const $ = cheerio.load(data);

      const articles = [];
      $(site.selector).each((i, element) => {
        const title = $(element).find("a").text().trim();
        const link = $(element).find("a").attr("href");
        if (title && link) {
          const fullLink = link.startsWith("http")
            ? link
            : `${site.url.split("/category")[0]}${link}`;
          articles.push({ title, link: fullLink, source: site.name });
        }
      });
      allArticles = [...allArticles, ...articles.slice(0, 10)];
    }
    logger.info(`Fetched ${allArticles.length} articles from source`);
    return allArticles;
  } catch (error) {
    logger.error("Error fetching article links from source:", error);
    sendErrorEmail(`Error fetching articles: ${error.message}`);
    return [];
  }
};

// Fetch full article content
const fetchFullArticle = async (url, source) => {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    let content;
    if (source === "123Telugu") {
      content = $(".entry-content").text().trim();
    } else {
      content = $(".article_body").text().trim();
    }
    return content || "Error loading content.";
  } catch (error) {
    logger.error("Error fetching full article content:", error);
    return "Error loading content.";
  }
};

// Count words in HTML content
const countWords = (htmlContent) => {
  const $ = cheerio.load(htmlContent);
  const text = $.text();
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  return words.length;
};

// Get random article link and title
const getRandomArticleLink = async (currentArticleLink) => {
  try {
    // Fetch up to 10 articles, excluding the current article to avoid self-linking
    const articles = await Article.find({
      wordpressPostUrl: { $ne: null },
      generatedTitle: { $ne: null },
      link: { $ne: currentArticleLink }, // Exclude the current article
    }).limit(10);

    if (articles.length === 0) {
      logger.info("No other articles available for random link");
      return null;
    }

    // Ensure true randomness by shuffling the array
    const shuffledArticles = articles.sort(() => Math.random() - 0.5);
    const randomArticle = shuffledArticles[0]; // Pick the first after shuffling

    return {
      url: randomArticle.wordpressPostUrl,
      title: randomArticle.generatedTitle,
    };
  } catch (error) {
    logger.error("Error fetching random article link:", error);
    sendErrorEmail(`Error fetching random article link: ${error.message}`);
    return null;
  }
};

// Regenerate article with AI
const regenerateArticle = async (originalContent, originalTitle, currentArticleLink) => {

  const prompt = `Write a detailed and engaging HTML-formatted article of 800+ words on the following topic, based on the content provided below.

Guidelines:
- Use a professional tone and active voice throughout.
- Structure the article with a compelling <h1> title and multiple <h2> subheadings.
- Start with an engaging introduction that hooks the reader.
- Organize body content into paragraphs with deep insights, relevant examples, and clarity.
- End with a strong conclusion summarizing the article’s core message.
- Avoid repetition and AI-like phrasing.
- Do not reference or mention the original source.
- The content should be original and flow naturally like human writing.
- Output must be valid, clean HTML.

Original Title:
"${originalTitle}"

Original Content:
"""${originalContent}"""
`;

  for (let i = 0; i < OPENROUTER_API_KEYS.length; i++) {
    const apiKey = OPENROUTER_API_KEYS[i];
    try {
      logger.info(`Attempting to regenerate article with API key ${i + 1}...`);
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "google/gemma-3-12b-it:free",
          messages: [{ role: "user", content: prompt }],
        },
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        }
      );

      if (!response.data.choices || response.data.choices.length === 0) {
        throw new Error("No choices returned in API response");
      }

      let htmlContent = response.data.choices[0].message.content;
      const wordCount = countWords(htmlContent);
      if (wordCount < 600) {
        throw new Error(`Generated article too short: ${wordCount} words`);
      }

      const $ = cheerio.load(htmlContent);
      const generatedTitle = $("h1").first().text().trim();
      if (!generatedTitle) {
        throw new Error("Generated title not found in response");
      }

      const seoKeywords = [];
      $('h2:contains("SEO Keywords")')
        .next("ul")
        .find("li")
        .each((i, el) => {
          seoKeywords.push($(el).text().trim());
        });

      $("h1").first().remove();
      $('h2:contains("SEO Keywords")').next("ul").remove();
      $('h2:contains("SEO Keywords")').remove();

      // Insert "Read More" link with random article title in the middle
      const randomArticle = await getRandomArticleLink(currentArticleLink);
      if (randomArticle) {
        const paragraphs = $("p").toArray();
        const midIndex = Math.floor(paragraphs.length / 2);
        if (midIndex > 0) {
          $(paragraphs[midIndex]).after(
            `<p><strong>Read More:</strong> <a href="${randomArticle.url}" target="_blank">${randomArticle.title}</a></p>`
          );
        }
      }

      // Append Instagram link
      $.root().append(
        `<p><strong>Follow us on Instagram:</strong> <a href="https://www.instagram.com/south_filmy_nagri_/" target="_blank">Join us on Instagram</a></p>`
      );

      const contentWithoutTitleAndKeywords = $.html();

      logger.info(`Regenerated article: "${generatedTitle}", word count: ${wordCount}`);
      return { content: contentWithoutTitleAndKeywords, seoKeywords, generatedTitle, wordCount };
    } catch (error) {
      logger.error(`Error with OpenRouter API key ${i + 1}:`, error.message);
      sendErrorEmail(`OpenRouter API Error with key ${i + 1}: ${error.message}`);
      if (i === OPENROUTER_API_KEYS.length - 1) throw new Error("All API keys failed");
      await sleep(1000);
    }
  }
};

// Fetch existing WordPress articles
const fetchWordPressArticles = async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const authHeader = `Basic ${Buffer.from(`${WP_USERNAME}:${WP_PASSWORD}`).toString("base64")}`;
    await page.setExtraHTTPHeaders({ Authorization: authHeader });

    logger.info("Fetching WordPress articles...");
    await page.goto(`${WP_URL}/wp-json/wp/v2/posts?per_page=10&status=publish,draft`, {
      waitUntil: "networkidle2",
    });

    const jsonData = await page.evaluate(() => JSON.parse(document.body.innerText));
    if (!jsonData || !Array.isArray(jsonData)) {
      logger.error("Unexpected WordPress API response:", jsonData);
      return [];
    }

    const articles = jsonData.map((post) => ({
      title: post.title.rendered,
      link: post.link,
      wordpressPostId: post.id,
      content: post.content.rendered,
    }));

    logger.info("Fetched articles from WordPress:", articles.map((a) => a.title));
    await browser.close();
    return articles;
  } catch (error) {
    logger.error("Error fetching WordPress articles:", error.message);
    sendErrorEmail(`Error fetching WordPress articles: ${error.message}`);
    await browser.close();
    return [];
  }
};

// Post to WordPress without SEO keywords
const postToWordPress = async (title, content) => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const authHeader = `Basic ${Buffer.from(`${WP_USERNAME}:${WP_PASSWORD}`).toString("base64")}`;
    await page.setExtraHTTPHeaders({ Authorization: authHeader });

    logger.info(`Posting to WordPress with regenerated title: "${title}"`);

    const postData = {
      title,
      content,
      status: "draft",
    };

    await page.goto(`${WP_URL}/wp-json/wp/v2/posts`, { waitUntil: "networkidle2" });

    const response = await page.evaluate(
      async (postData, authHeader) => {
        const res = await fetch("/wp-json/wp/v2/posts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(postData),
        });
        return await res.json();
      },
      postData,
      authHeader
    );

    if (response.code) {
      throw new Error(`WordPress API error: ${response.message}`);
    }

    const postId = response.id;
    const postUrl = response.link;
    logger.info(`Saved to WordPress. Post ID: ${postId}, URL: ${postUrl}`);
    await browser.close();
    return { id: postId, link: postUrl };
  } catch (error) {
    logger.error("Error posting to WordPress:", error.message);
    sendErrorEmail(`Error posting to WordPress: ${error.message}`);
    await browser.close();
    throw error;
  }
};

// Process and save articles
const processAndSaveArticles = async () => {
  let newArticlesCount = 0;
  try {
    const wordpressArticles = await fetchWordPressArticles();
    const sourceArticles = await fetchArticlesFromSource();

    for (const article of sourceArticles) {
      const existingArticle = await Article.findOne({ link: article.link });
      if (existingArticle) {
        logger.info(`Skipped existing article: ${article.title}`);
        continue;
      }

      const fullContent = await withRetry(() => fetchFullArticle(article.link, article.source));
      if (fullContent === "Error loading content.") {
        logger.error(`Failed to fetch content for: ${article.title}`);
        continue;
      }

      await sleep(1000);
      const { content: regeneratedContent, seoKeywords, generatedTitle, wordCount } = await withRetry(() =>
        regenerateArticle(fullContent, article.title, article.link)
      );

      logger.info(`Processed article with regenerated title: "${generatedTitle}"`);

      let wordpressPostId, wordpressPostUrl;
      try {
        const wpPost = await withRetry(() => postToWordPress(generatedTitle, regeneratedContent));
        wordpressPostId = wpPost.id;
        wordpressPostUrl = wpPost.link;
      } catch (wpError) {
        logger.error(`Failed to post to WordPress: ${generatedTitle}`, wpError.message);
      }

      await Article.updateOne(
        { link: article.link },
        {
          $setOnInsert: {
            title: article.title,
            generatedTitle,
            link: article.link,
            source: article.source,
            fullContent,
            regeneratedContent,
            wordCount,
            seoKeywords,
            wordpressPostId,
            wordpressPostUrl,
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
      logger.info(`Saved article with regenerated title: "${generatedTitle}"`);
      newArticlesCount++;
      await sleep(5000); // Rate limiting
    }

    return {
      message: `Processed ${newArticlesCount} new articles with regenerated titles, ${sourceArticles.length - newArticlesCount
        } skipped.`,
    };
  } catch (error) {
    logger.error("Error processing articles:", error);
    sendErrorEmail(`Error processing articles: ${error.message}`);
    throw error;
  }
};

// Schedule processing every 10 minutes
const POLLING_INTERVAL = 10 * 60 * 1000;
setInterval(async () => {
  logger.info("Starting scheduled article processing...");
  await processAndSaveArticles();
  logger.info("Scheduled processing completed.");
}, POLLING_INTERVAL);

// Initial run
processAndSaveArticles().catch((error) => {
  logger.error("Initial processing failed:", error);
  sendErrorEmail(`Initial processing failed: ${error.message}`);
});

// API endpoints
app.get("/api/process-articles", async (req, res) => {
  try {
    const result = await processAndSaveArticles();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/articles", async (req, res) => {
  try {
    const savedArticles = await Article.find().sort({ createdAt: -1 });
    res.json(savedArticles);
  } catch (error) {
    res.status(500).json({ error: "Server error retrieving articles" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));