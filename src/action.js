const axios = require("axios");
const { Octokit } = require("@octokit/rest");
const { NodeHtmlMarkdown } = require('node-html-markdown');
const sprightly = require('sprightly')

const process = require('process')
process.chdir(__dirname)

const COMMIT_MESSAGE = '[';
const LANG_TO_EXTENSION = {
  'golang': 'go',
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function log(message) {
  console.log(`[${new Date().toUTCString()}] ${message}`);
}

async function commit(params) {
  const {
    octokit,
    owner,
    repo,
    defaultBranch,
    commitInfo,
    treeSHA,
    latestCommitSHA,
    submission,
  } = params;

  log(`Committing solution ${submission.id} for ${submission.title}...`);

  if (!LANG_TO_EXTENSION[submission.lang]) {
    throw `Language ${submission.lang} does not have a registered extension.`;
  }

  const treeData = [
    {
      path: `${submission.title}/${submission.slug}.${LANG_TO_EXTENSION[submission.lang]}`,
      mode: '100644',
      content: submission.code,
    },
    {
      path: `${submission.title}/README.md`,
      mode: '100644',
      content: submission.readme,
    }
  ];

  const treeResponse = await octokit.git.createTree({
    owner: owner,
    repo: repo,
    base_tree: treeSHA,
    tree: treeData,
  });

  const date = new Date(submission.timestamp * 1000).toISOString();
  const commitResponse = await octokit.git.createCommit({
    owner: owner,
    repo: repo,
    message: `${COMMIT_MESSAGE}${submission.difficulty}] [${submission.tags}] [${submission.runtimeDisplay}] [${submission.memoryDisplay}]`,
    tree: treeResponse.data.sha,
    parents: [latestCommitSHA],
    author: {
      email: commitInfo.email,
      name: commitInfo.name,
      date: date,
    },
    committer: {
      email: commitInfo.email,
      name: commitInfo.name,
      date: date,
    },
  })

  await octokit.git.updateRef({
    owner: owner,
    repo: repo,
    sha: commitResponse.data.sha,
    ref: 'heads/' + defaultBranch,
    force: true
  });

  log(`Committed solution ${submission.id} for ${submission.title}`);

  return [treeResponse.data.sha, commitResponse.data.sha];
}

// Returns false if no more submissions should be added.
function addToSubmissions(params) {
  const {
    response,
    submissions,
    mostRecentTimestamp
  } = params;

  for (const submission of response.data.data.submissionList.submissions) {
    submissionTimestamp = Number(submission.timestamp);
    if (submissionTimestamp <= mostRecentTimestamp) {
      return false;
    }
    if (submission.statusDisplay !== "Accepted") {
      continue;
    }

    submissions.push({
      id: submission.id,
      titleSlug: submission.titleSlug
    });
  }


  return true;
}

async function sync(inputs) {
  const {
    githubToken,
    owner,
    repo,
    leetcodeCSRFToken,
    leetcodeSession,
  } = inputs;

  const octokit = new Octokit({
    auth: githubToken,
    userAgent: "LeetCode sync to GitHub - GitHub Action",
  });
  // First, get the time the timestamp for when the syncer last ran.
  const commits = await octokit.repos.listCommits({
    owner: owner,
    repo: repo,
    per_page: 100,
  });



  let mostRecentTimestamp = 0;
  // commitInfo is used to get the original name / email to use for the author / committer.
  // Since we need to modify the commit time, we can't use the default settings for the
  // authenticated user.
  let commitInfo = commits.data[commits.data.length - 1].commit.author;
  for (const commit of commits.data) {
    if (!commit.commit.message.startsWith(COMMIT_MESSAGE)) {
      continue
    }
    commitInfo = commit.commit.author;
    mostRecentTimestamp = Date.parse(commit.commit.committer.date) / 1000;
    break;
  }

  // Get all Accepted submissions from LeetCode greater than the timestamp.
  let response = null;
  let offset = 0;
  const submissions = [];

  do {
    log(`Getting submission from LeetCode, offset ${offset}`);

    const getSubmissions = async (maxRetries, retryCount = 0) => {
      try {
        const slug = undefined;
        const graphql = JSON.stringify({
          query: `query ($offset: Int!, $limit: Int!, $slug: String) {
              submissionList(offset: $offset, limit: $limit, questionSlug: $slug) {
                  hasNext
                  submissions {
                      id
                      lang
                      timestamp
                      statusDisplay
                      runtime
                      title
                      memory
                      titleSlug
                  }
              }
          }`,
          variables: {
            offset: offset,
            limit: 20,
            slug,
          },
        });

        const headers = graphqlHeaders(leetcodeSession, leetcodeCSRFToken);
        const response = await axios.post(
          "https://leetcode.com/graphql/",
          graphql,
          { headers },
        );
        log(`Successfully fetched submission from LeetCode, offset ${offset}`);
        return response;
      } catch (exception) {
        if (retryCount >= maxRetries) {
          throw exception;
        }
        log(
          "Error fetching submissions, retrying in " +
          3 ** retryCount +
          " seconds...",
        );
        // There's a rate limit on LeetCode API, so wait with backoff before retrying.
        await delay(3 ** retryCount * 1000);
        return getSubmissions(maxRetries, retryCount + 1);
      }
    };
    // On the first attempt, there should be no rate limiting issues, so we fail immediately in case
    // the tokens are configured incorrectly.
    const maxRetries = response === null ? 0 : 5;
    if (response !== null) {
      // Add a 1 second delay before all requests after the initial request.
      await delay(1000);
    }
    response = await getSubmissions(maxRetries);
    if (
      !addToSubmissions({
        response,
        submissions,
        mostRecentTimestamp
      })
    ) {
      break;
    }

    offset += 20;
  } while (response.data.data.submissionList.hasNext);

  // We have all submissions we want to write to GitHub now.
  // First, get the default branch to write to.
  const repoInfo = await octokit.repos.get({
    owner: owner,
    repo: repo,
  });
  const defaultBranch = repoInfo.data.default_branch;
  log(`Default branch for ${owner}/${repo}: ${defaultBranch}`);
  // Write in reverse order (oldest first), so that if there's errors, the last sync time
  // is still valid.
  log(`Syncing ${submissions.length} submissions...`);
  let latestCommitSHA = commits.data[0].sha;
  let treeSHA = commits.data[0].commit.tree.sha;

  for (i = submissions.length - 1; i >= 0; i--) {
    const submissionData = await getSubmissionData(submissions[i].id, leetcodeSession, leetcodeCSRFToken)
    const questionData = await getQuestionData(submissions[i].titleSlug, leetcodeSession, leetcodeCSRFToken)

    const details = {
      submissionDetails: submissionData.data.data.submissionDetails,
      question: questionData.data.data.question
    }

    const tags = [];
    for (const t in details.question.topicTags) {
      // tags.push(` [${details.question.topicTags[t].name}](https://leetcode.com/tag/${details.question.topicTags[t].slug})`);
      tags.push(details.question.topicTags[t].name);
    }

    let submission = {
      id: submissions[i].id,
      slug: submissions[i].titleSlug,
      title: details.question.title,
      lang: details.submissionDetails.lang.name,
      timestamp: details.submissionDetails.timestamp,
      code: details.submissionDetails.code,
      question: NodeHtmlMarkdown.translate(details.question.content),
      difficulty: details.question.difficulty,
      tags: tags,
      runtimeDisplay: details.submissionDetails.runtimeDisplay,
      memoryDisplay: details.submissionDetails.memoryDisplay,
    };

    submission.readme = sprightly.sprightly('readme.tmpl', submission);

    [treeSHA, latestCommitSHA] = await commit({
      octokit,
      owner,
      repo,
      defaultBranch,
      commitInfo,
      treeSHA,
      latestCommitSHA,
      submission,
    });
  }
  log("Done syncing all submissions.");
}

function graphqlHeaders(session, csrfToken) {
  return {
    'X-Requested-With': 'XMLHttpRequest',
    "Content-Type": "application/json",
    "X-CSRFToken": csrfToken,
    "Cookie": `csrftoken=${csrfToken};LEETCODE_SESSION=${session};`,
  };
}

async function getSubmissionData(id, session, csrfToken) {
  let data = JSON.stringify({
    query: `query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        runtimeDisplay
        memoryDisplay
        code
        timestamp
        lang {
          name
        }
      }
    }`,
    variables: {
      submissionId: id
    },
  });

  const headers = graphqlHeaders(session, csrfToken);

  // No need to break on first request error since that would be done when getting submissions
  const getInfo = async (maxRetries = 5, retryCount = 0) => {
    try {
      const response = await axios.post("https://leetcode.com/graphql/", data, {
        headers,
      });

      log(`Got info for submission #${id}`);
      return response
    } catch (exception) {
      if (retryCount >= maxRetries) {
        throw exception;
      }
      log(
        "Error fetching submission info, retrying in " +
        3 ** retryCount +
        " seconds...",
      );
      await delay(3 ** retryCount * 1000);
      return getInfo(maxRetries, retryCount + 1);
    }
  };

  return await getInfo();
}


async function getQuestionData(titleSlug, session, csrfToken) {
  log(`Getting question data for ${titleSlug}...`);

  const headers = graphqlHeaders(session, csrfToken);
  const graphql = JSON.stringify({
    query: `query getQuestionDetail($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        title
        content
        difficulty
        topicTags {
          name
        }
      }
    }`,
    variables: { titleSlug: titleSlug },
  });

  try {
    const response = await axios.post(
      "https://leetcode.com/graphql/",
      graphql,
      { headers },
    );
    return response
  } catch (error) {
    console.log("error", error);
  }
}



module.exports = { log, sync };
