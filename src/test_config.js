require("dotenv").config();
// Modify this file to run index.js locally and not as a GitHub Action.

module.exports = {
  // These parameters are required.
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO, // Form of '<owner>/<repo_name>'
  LEETCODE_CSRF_TOKEN: process.env.LEETCODE_CSRF_TOKEN,
  LEETCODE_SESSION: process.env.LEETCODE_SESSION,
};
