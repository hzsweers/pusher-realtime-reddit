var _ = require("underscore");
var request = require("request");

var silent = false;

var config;
try {
  config = require("./config");
} catch(e) {
  if (!silent) console.log("Failed to find local config, falling back to environment variables");
  config = {
    reddit_app_id: process.env.REDDIT_APP_ID,
    reddit_app_secret: process.env.REDDIT_APP_SECRET,
    reddit_authorization_code: process.env.REDDIT_AUTHORIZATION_CODE,
    reddit_refresh_token: process.env.REDDIT_REFRESH_TOKEN,
    pusher_app_id: process.env.PUSHER_APP_ID,
    pusher_key: process.env.PUSHER_APP_KEY,
    pusher_secret: process.env.PUSHER_APP_SECRET
  }
}

// --------------------------------------------------------------------
// SET UP PUSHER
// --------------------------------------------------------------------
var Pusher = require("pusher");
var pusher = new Pusher({
  appId: config.pusher_app_id,
  key: config.pusher_key,
  secret: config.pusher_secret
});


// --------------------------------------------------------------------
// REDDIT
// --------------------------------------------------------------------
var accessToken = "";
var accessTokenTime;
var previousListings = {};
var lastId;
var scrapeTimer;
var scrapeRequest;

var getAccessToken = function(callback) {
  if (!silent) console.log("getAccessToken()");

  var url = "https://ssl.reddit.com/api/v1/access_token";

  var options = {
    url: url,
    method: "POST",
    form: {
      grant_type: "refresh_token",
      refresh_token: config.reddit_refresh_token
    },
    auth: {
      user: config.reddit_app_id,
      pass: config.reddit_app_secret
    },
    json: true,
    timeout: 10000
  };

  if (!silent) console.log("Requesting access token");
  request(options, function(error, response, body) {
    if (!silent) console.log("Access token request callback");

    if (response.statusCode == 401) {
      if (!silent) console.log("Client credentials sent as HTTP Basic Authorization were invalid");
      return;
    }

    if (body.error && body.error == "unsupported_grant_type") {
      if (!silent) console.log("grant_type parameter was invalid");
      return;
    } else if (body.error) {
      if (!silent) console.log(body.error);
      return;
    }

    accessToken = body.access_token;
    accessTokenTime = Date.now();

    callback();
  });
};

var checkAccess = function(callback) {
  if (!silent) console.log("checkAccess()");

  var url = "https://oauth.reddit.com/api/v1/me.json";

  var options = {
    url: url,
    auth: {
      bearer: accessToken
    },
    headers: {
      "User-Agent": "realtime-reddit/0.0.1 by Pusher"
    },
    json: true,
    timeout: 10000
  };

  if (!silent) console.log("Requesting me.json");
  request(options, function(error, response, body) {
    if (!silent) console.log("me.json request callback");

    if (response.statusCode == 200) {
      callback(true);
    } else {
      callback(false);
    }
  });
};

var getNewListings = function(callback) {
  if (!silent) console.log("getNewListings()");

  var url = "https://oauth.reddit.com/new.json?limit=50";

  var options = {
    url: url,
    headers: {
      "Authorization": "bearer " + accessToken,
      "User-Agent": "realtime-reddit/0.0.1 by Pusher"
    },
    gzip: true,
    timeout: 10000
  };

  if (!silent) console.log("Requesting new listings");
  scrapeRequest = request(options, function(error, response, body) {
    if (!silent) console.log("New listings request callback");

    if (error) {
      if (!silent) console.log("New listings request error");
      if (!silent) console.log(error);
      if (!silent) console.log(response);
      callback();
      return;
    }

    console.log("1");
    
    // Re-authenticate
    if (response.statusCode && response.statusCode == 401) {
      console.log("1.1");
      if (!silent) console.log("HTTP 401 on /new.json");
      authenticateAndScrape();
      return;
    }

    console.log("2");

    if (response.headers && response.headers["x-ratelimit-remaining"] && response.headers["x-ratelimit-reset"]) {
      console.log("2.1");
      if (!silent) console.log("Rate remaining: " + response.headers["x-ratelimit-remaining"]);
      if (!silent) console.log("Rate reset (seconds): " + response.headers["x-ratelimit-reset"]);
    }

    console.log("3");

    if (response.statusCode) {
      console.log("3.1");
      if (!silent) console.log("Status code: " + response.statusCode);
    }

    console.log("4");

    try {
      body = JSON.parse(body);

      console.log("5");

      if (body.data && body.data.children.length > 0) {
        console.log("5.1");
        processListings(body.data.children);
        lastId = body.data.children[0].data.name;
      }
    } catch(e) {
      console.log("4.1");
      callback();
      return;
    }

    console.log("6");

    callback();
  });
};

var scrapeListings = function() {
  if (!silent) console.log("------------------------------------------");
  if (!silent) console.log(new Date().toString());
  if (!silent) console.log("scrapeListings()");
  try {
    if (!silent) console.log("Clearing scrape timer");
    clearTimeout(scrapeTimer);

    // Check access token time
    // 2700000 = 45 minutes
    if (Date.now() - accessTokenTime > 2700000) {
      if (!silent) console.log("Refreshing token after 45 minutes");
      refreshAccessToken();
      return; 
    }

    getNewListings(function() {
      if (!silent) console.log("Starting scrape timer");
      scrapeTimer = setTimeout(function() {
        scrapeListings();
      }, 2000);
    });
  } catch(e) {
    if (!silent) console.log("Error");
    if (!silent) console.log(e);

    scrapeTimer = setTimeout(function() {
      scrapeListings();
    }, 2000);
  };
};

var processListings = function(listings) {
  if (!silent) console.log("processListings()");

  var count = 0;

  _.each(listings, function(listing, index) {
    // Look for existing listing
    if (!previousListings[listing.data.subreddit] || previousListings[listing.data.subreddit].indexOf(listing.data.name) < 0) {
      if (!silent) console.log("Adding listing to previous listings for /r/" + listing.data.subreddit);
      
      if (!previousListings[listing.data.subreddit]) {
        previousListings[listing.data.subreddit] = [];
      }

      previousListings[listing.data.subreddit].unshift(listing.data.name);

      // Cap previous listings
      if (previousListings[listing.data.subreddit].length > 50) {
        if (!silent) console.log("Cropping previous listings for /r/" + listing.data.subreddit);
        previousListings[listing.data.subreddit].splice(49);
      }

      if (!silent) console.log("Triggering message on Pusher");
      pusher.trigger(listing.data.subreddit.toLowerCase(), "new-listing", listing.data);
      count++;
    }
  });

  if (!silent) console.log(count + " new listings");
};

var authenticateAndScrape = function() {
  if (!silent) console.log("authenticateAndScrape()");
  checkAccess(function(success) {
    if (!accessToken || !success) {    
      if (!silent) console.log("Access denied");
      getAccessToken(function() {
        if (!silent) console.log("Access granted");
        scrapeListings();
      });
    } else {
      if (!silent) console.log("Access granted");
      scrapeListings();
    }
  });
};

var refreshAccessToken = function() {
  getAccessToken(function() {
    if (!silent) console.log("Access granted");
    scrapeListings();
  });
};

authenticateAndScrape();

// Capture uncaught errors
process.on("uncaughtException", function(err) {
  if (!silent) console.log(err);

  if (!silent) console.log("Attempting to restart scraper");

  if (!silent) console.log("Aborting previous request");
  if (scrapeRequest) {
    scrapeRequest.abort();
  }

  scrapeListings();
});