const { Client } = require('@microsoft/microsoft-graph-client');
const pdfParse = require('pdf-parse');
const { Buffer } = require('buffer');
const path = require('path');
const axios = require('axios');
const qs = require('querystring');
const { OpenAI } = require("openai");

// Function to initialize Microsoft Graph client
const initGraphClient = (accessToken) => {
    return Client.init({
        authProvider: (done) => {
            done(null, accessToken); // Pass the access token for Graph API calls
        }
    });
};

// Function to obtain OBO token. This will take the access token in request header (scoped to this Function App) and generate a new token to use for Graph API
const getOboToken = async (userAccessToken) => {
    const { TENANT_ID, CLIENT_ID, CLIENT_SECRET } = process.env;
    const scope = 'https://graph.microsoft.com/.default';
    const oboTokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

    const params = {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: userAccessToken,
        requested_token_use: 'on_behalf_of',
        scope: scope
    };

    try {
        const response = await axios.post(oboTokenUrl, qs.stringify(params), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        return response.data.access_token; // OBO token
    } catch (error) {
        console.error('Error obtaining OBO token:', error.response?.data || error.message);
        throw error;
    }
};

// Function to fetch drive item content
const getDriveItemContent = async (client, driveId, itemId, name) => {
    try {
        const fileType = path.extname(name).toLowerCase();
        // the below files types are the ones that are able to be converted to PDF to extract the text. See https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format?view=graph-rest-1.0&tabs=http
        const allowedFileTypes = ['.pdf', '.csv', '.doc', '.docx', '.odp', '.ods', '.odt', '.pot', '.potm', '.potx', '.pps', '.ppsx', '.ppsxm', '.ppt', '.pptm', '.pptx', '.rtf', '.xls', '.xlsx'];
        let response;
        if (allowedFileTypes.includes(fileType)) {
            if (fileType === '.pdf') {
                // If the file is a PDF already, it just converts to a stream using getStream()
                response = await client.api(`/drives/${driveId}/items/${itemId}/content`).getStream();
            } else {
                // if the file is not a PDF, it first converts to PDF and then converts to a stream
                response = await client.api(`/drives/${driveId}/items/${itemId}/content?format=pdf`).getStream();
            }
            // The below takes the chunks in response and combines
            let chunks = [];
            for await (let chunk of response) {
                chunks.push(chunk);
            }
            let buffer = Buffer.concat(chunks);
            // the below extracts the text from the PDF.
            const pdfContents = await pdfParse(buffer);
            return pdfContents.text;
        } else if (fileType === '.txt') {
            // If the type is txt, it does not need to create a stream and instead just grabs the content
            response = await client.api(`/drives/${driveId}/items/${itemId}/content`).get();
            return response;
        } else {
            // We ignore other file types
            return 'Unsupported File Type';
        }
    } catch (error) {
        console.error('Error fetching drive content:', error);
        throw new Error(`Failed to fetch content for ${name}: ${error.message}`);
    }
};

// Function to get relevant parts of document using gpt-3.5-turbo. 
const getRelevantParts = async (text, query) => {
    try {
        // We use your OpenAI key to initialize the OpenAI client
        const openAIKey = process.env["OPENAI_API_KEY"];
        const openai = new OpenAI({
            apiKey: openAIKey,
        });
        const response = await openai.chat.completions.create({
            // Using gpt-3.5-turbo due to speed to prevent timeouts. You can tweak this prompt as needed
            model: "gpt-3.5-turbo-0125",
            messages: [
                {"role": "system", "content": "You are a helpful assistant that finds relevant content in text based on a query. You only return the relevant sentences, and you return a maximum of 10 sentences"},
                {"role": "user", "content": `Based on this question: **"${query}"**, get the relevant parts from the following text:*****\n\n${text}*****. If you cannot answer the question based on the text, respond with 'No information provided'`}
            ],
            // using temperature of 0 since we want to just extract the relevant content
            temperature: 0,
            // using max_tokens of 1000, but you can customize this based on the number of documents you are searching. 
            max_tokens: 1000
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error with OpenAI:', error);
        return 'Error processing text with OpenAI' + error;
    }
};
// Below is what the Azure Function executes
module.exports = async function (context, req) {
    const query = req.query.query || (req.body && req.body.query);
    const searchTerm = req.query.searchTerm || (req.body && req.body.searchTerm);
    if (!req.headers.authorization) {
        context.res = {
            status: 400,
            body: 'Authorization header is missing'
        };
        return;
    }
    /// The below takes the token passed to the function, to use to get an OBO token.
    const bearerToken = req.headers.authorization.split(' ')[1];
    let accessToken;
    try {
        accessToken = await getOboToken(bearerToken);
    } catch (error) {
        context.res = {
            status: 500,
            body: `Failed to obtain OBO token: ${error.message}`
        };
        return;
    }
    // Initialize the Graph Client using the initGraphClient function defined above
    let client = initGraphClient(accessToken);
    // this is the search body to be used in the Microsft Graph Search API: https://learn.microsoft.com/en-us/graph/search-concept-files
    const requestBody = {
        requests: [
            {
                entityTypes: ['driveItem'],
                query: {
                    queryString: searchTerm
                },
                from: 0,
                // the below is set to summarize the top 10 search results from the Graph API, but can configure based on your documents. 
                size: 10
            }
        ]
    };

    try { 
        // Function to tokenize content (e.g., based on words). 
        const tokenizeContent = (content) => {
            return content.split(/\s+/);
        };

        // Function to break tokens into 10k token windows for gpt-3.5-turbo
        const breakIntoTokenWindows = (tokens) => {
            const tokenWindows = []
            const maxWindowTokens = 10000; // 10k tokens
            let startIndex = 0;

            while (startIndex < tokens.length) {
                const window = tokens.slice(startIndex, startIndex + maxWindowTokens);
                tokenWindows.push(window);
                startIndex += maxWindowTokens;
            }

            return tokenWindows;
        };
        const list = await client.api('/search/query').post(requestBody);

        const processList = async () => {
            // This will go through and for each search response, grab the contents of the file and summarize with gpt-3.5-turbo
            const results = [];

            await Promise.all(list.value[0].hitsContainers.map(async (container) => {
                for (const hit of container.hits) {
                    if (hit.resource["@odata.type"] === "#microsoft.graph.driveItem") {
                        const { name, id } = hit.resource;
                        // We use the below to grab the URL of the file to include in the response
                        const webUrl = hit.resource.webUrl.replace(/\s/g, "%20");
                        // The Microsoft Graph API ranks the reponses, so we use this to order it
                        const rank = hit.rank;
                        // The below is where the file lives
                        const driveId = hit.resource.parentReference.driveId;
                        const contents = await getDriveItemContent(client, driveId, id, name);
                        if (contents !== 'Unsupported File Type') {
                            // Tokenize content using function defined previously
                            const tokens = tokenizeContent(contents);

                            // Break tokens into 10k token windows
                            const tokenWindows = breakIntoTokenWindows(tokens);

                            // Process each token window and combine results
                            const relevantPartsPromises = tokenWindows.map(window => getRelevantParts(window.join(' '), query));
                            const relevantParts = await Promise.all(relevantPartsPromises);
                            const combinedResults = relevantParts.join('\n'); // Combine results

                            results.push({ name, webUrl, rank, contents: combinedResults });
                        } else {
                            results.push({ name, webUrl, rank, contents: 'Unsupported File Type' });
                        }
                    }
                }
            }));

            return results;
        };
        let results;
        if (list.value[0].hitsContainers[0].total == 0) {
            // Return no results found to the API if the Microsoft Graph API returns no results
            results = 'No results found';
        } else {
            // If the Microsoft Graph API does return results, then run processList to iterate through.
            results = await processList();
            results.sort((a, b) => a.rank - b.rank);
        }
        context.res = {
            status: 200,
            body: results
        };
    } catch (error) {
        context.res = {
            status: 500,
            body: `Error performing search or processing results: ${error.message}`,
        };
    }
};

