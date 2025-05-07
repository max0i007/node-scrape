// M3U8 Extractor API (Node.js)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { VM } = require('vm2');
const morgan = require('morgan');

// Set up Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Function to unpack eval-packed JavaScript
function unpack(packedJs) {
    try {
        // Create a sandbox to safely evaluate the packed code
        const vm = new VM({
            sandbox: {
                result: null,
                window: {},
                document: {}
            }
        });

        // Replace eval with a function that captures the result
        const unpacker = `
            function unpack(packed) {
                var env = {
                    eval: function(c) { result = c; },
                    window: {},
                    document: {}
                };
                var result;
                with(env) { eval(packed); }
                return result;
            }
            result = unpack(${JSON.stringify(packedJs)});
        `;

        vm.run(unpacker);
        return vm.sandbox.result;
    } catch (error) {
        console.error('Error unpacking JavaScript:', error);
        
        // Try alternative unpacking method
        try {
            const alternativeUnpacker = `
                function unPack(code) {
                    function indent(code) {
                        var tabs = 0, old = -1, add = '';
                        for (var i = 0; i < code.length; i++) {
                            if (code[i].indexOf("{") != -1) tabs++;
                            if (code[i].indexOf("}") != -1) tabs--;
                            
                            if (old != tabs) {
                                old = tabs;
                                add = "";
                                while (old > 0) {
                                    add += "\\t";
                                    old--;
                                }
                                old = tabs;
                            }
                            
                            code[i] = add + code[i];
                        }
                        return code;
                    }
                    
                    var env = {
                        eval: function(c) { code = c; },
                        window: {},
                        document: {}
                    };
                    
                    var code;
                    eval("with(env) {" + code + "}");
                    
                    code = (code+"").replace(/;/g, ";\\n").replace(/{/g, "\\n{\\n").replace(/}/g, "\\n}\\n").replace(/\\n;\\n/g, ";\\n").replace(/\\n\\n/g, "\\n");
                    
                    code = code.split("\\n");
                    code = indent(code);
                    
                    return code.join("\\n");
                }
                result = unPack(${JSON.stringify(packedJs)});
            `;
            
            const vm2 = new VM({
                sandbox: {
                    result: null,
                    window: {},
                    document: {}
                }
            });
            
            vm2.run(alternativeUnpacker);
            return vm2.sandbox.result;
        } catch (alternativeError) {
            console.error('Alternative unpacking also failed:', alternativeError);
            return null;
        }
    }
}

// Extract m3u8 links from unpacked JavaScript
function extractM3u8Links(unpackedJs) {
    if (!unpackedJs) return [];
    
    // Pattern to match JWPlayer setup with sources array
    const jwplayerPattern = /sources\s*:\s*\[([^\]]+)\]/;
    const jwplayerMatches = jwplayerPattern.exec(unpackedJs);
    
    let m3u8Links = [];
    
    // If we found JWPlayer sources array
    if (jwplayerMatches && jwplayerMatches[1]) {
        const sourcesText = jwplayerMatches[1];
        // Look for file URLs within the sources
        const filePattern = /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/g;
        let match;
        while ((match = filePattern.exec(sourcesText)) !== null) {
            m3u8Links.push(match[1]);
        }
    }
    
    // Also look for general m3u8 URLs as fallback
    const generalPattern = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g;
    let generalMatch;
    while ((generalMatch = generalPattern.exec(unpackedJs)) !== null) {
        m3u8Links.push(generalMatch[0]);
    }
    
    // Filter out duplicates while preserving order
    const uniqueLinks = [];
    const seen = new Set();
    for (const link of m3u8Links) {
        if (!seen.has(link)) {
            uniqueLinks.push(link);
            seen.add(link);
        }
    }
    
    return uniqueLinks;
}

// Find eval-packed JavaScript in HTML content
function findEvalPackedJs(htmlContent) {
    const pattern = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\)\)/g;
    return htmlContent.match(pattern) || [];
}

// Extract slug from URL
function extractSlugFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        
        // The last part of the path is typically the slug
        if (pathParts.length > 0) {
            return pathParts[pathParts.length - 1];
        }
        
        // Try to get from query parameters
        const params = new URLSearchParams(urlObj.search);
        if (params.has('id')) {
            return params.get('id');
        }
        
        return null;
    } catch (error) {
        console.error('Error extracting slug:', error);
        return null;
    }
}

// Fetch HTML content by slug
async function fetchHtmlBySlug(slug) {
    try {
        const url = `https://zpjid.com/bkg/${slug}?ref=animedub.pro`;
        console.log(`Fetching URL: ${url}`);
        
        const response = await axios.get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://animedub.pro/'
            }
        });
        
        return response.data;
    } catch (error) {
        console.error(`Error fetching HTML: ${error.message}`);
        
        // Try with backup headers on timeout
        if (error.code === 'ECONNABORTED') {
            console.log('Request timed out, retrying with increased timeout');
            try {
                const response = await axios.get(`https://zpjid.com/bkg/${slug}?ref=animedub.pro`, {
                    timeout: 60000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9'
                    }
                });
                return response.data;
            } catch (retryError) {
                console.error('Retry also failed:', retryError);
                throw new Error(`Request timeout error: ${error.message}`);
            }
        }
        
        throw error;
    }
}

// Main function to fetch page and extract m3u8 links
async function getM3u8FromSource(url) {
    try {
        // Extract slug from URL
        const slug = extractSlugFromUrl(url);
        if (!slug) {
            return {
                success: false,
                error: "Could not extract slug from URL"
            };
        }
        
        console.log(`Extracted slug: ${slug}`);
        
        // Fetch the page
        console.log(`Fetching URL: ${url}`);
        const response = await axios.get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://animedub.pro/'
            }
        });
        
        // Find eval-packed JavaScript
        const packedScripts = findEvalPackedJs(response.data);
        console.log(`Found ${packedScripts.length} packed scripts`);
        
        if (!packedScripts || packedScripts.length === 0) {
            console.warn("No packed scripts found, response length: " + response.data.length);
            // Save a sample of the response for debugging
            const sample = response.data.length > 500 ? response.data.substring(0, 500) + "..." : response.data;
            console.debug(`Response sample: ${sample}`);
            return {
                success: false,
                error: "No eval-packed scripts found"
            };
        }
        
        // Process each packed script
        const allM3u8Links = [];
        
        for (let i = 0; i < packedScripts.length; i++) {
            console.log(`Processing packed script ${i+1}`);
            
            // Debug info for script size
            const scriptSize = packedScripts[i].length;
            console.debug(`Script ${i+1} size: ${scriptSize} bytes`);
            
            // Unpack the JavaScript
            const unpackedJs = unpack(packedScripts[i]);
            
            if (!unpackedJs) {
                console.warn(`Failed to unpack script ${i+1}`);
                continue;
            }
            
            // Extract m3u8 links
            const m3u8Links = extractM3u8Links(unpackedJs);
            allM3u8Links.push(...m3u8Links);
            
            console.log(`Found ${m3u8Links.length} m3u8 links in script ${i+1}`);
        }
        
        // Remove duplicates from all found links
        const uniqueM3u8Links = [...new Set(allM3u8Links)];
        
        // If no links found at all, return appropriate error
        if (!uniqueM3u8Links || uniqueM3u8Links.length === 0) {
            return {
                success: false,
                slug: slug,
                total_packed_scripts: packedScripts.length,
                error: "No m3u8 links found in any scripts"
            };
        }
        
        return {
            success: true,
            slug: slug,
            total_packed_scripts: packedScripts.length,
            m3u8_links: uniqueM3u8Links,
            count: uniqueM3u8Links.length
        };
    } catch (error) {
        console.error('Error:', error);
        
        // Handle timeout errors specially
        if (error.code === 'ECONNABORTED') {
            console.log('Request timed out, retrying with increased timeout');
            try {
                return await getM3u8FromSourceWithBackupHeaders(url, 60000);
            } catch (retryError) {
                console.error('Retry also failed:', retryError);
                return {
                    success: false,
                    error: `Request timeout error: ${error.message}`
                };
            }
        }
        
        // Handle other request errors
        if (error.response) {
            // Server responded with non-2xx status
            return {
                success: false,
                error: `Request error: ${error.response.status} ${error.response.statusText}`
            };
        } else if (error.request) {
            // Request was made but no response
            return {
                success: false,
                error: `No response received: ${error.message}`
            };
        } else {
            // Error in setting up the request
            return {
                success: false,
                error: `Request setup error: ${error.message}`
            };
        }
    }
}

// Fallback function with alternative headers
async function getM3u8FromSourceWithBackupHeaders(url, timeout) {
    try {
        const response = await axios.get(url, {
            timeout: timeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        
        const slug = extractSlugFromUrl(url);
        const packedScripts = findEvalPackedJs(response.data);
        
        if (!packedScripts || packedScripts.length === 0) {
            return {
                success: false,
                error: "No eval-packed scripts found with backup headers"
            };
        }
        
        // Process each packed script
        const allM3u8Links = [];
        
        for (let i = 0; i < packedScripts.length; i++) {
            const unpackedJs = unpack(packedScripts[i]);
            if (unpackedJs) {
                const m3u8Links = extractM3u8Links(unpackedJs);
                allM3u8Links.push(...m3u8Links);
            }
        }
        
        const uniqueM3u8Links = [...new Set(allM3u8Links)];
        
        if (!uniqueM3u8Links || uniqueM3u8Links.length === 0) {
            return {
                success: false,
                slug: slug,
                total_packed_scripts: packedScripts.length,
                error: "No m3u8 links found in any scripts with backup headers"
            };
        }
        
        return {
            success: true,
            slug: slug,
            total_packed_scripts: packedScripts.length,
            m3u8_links: uniqueM3u8Links,
            count: uniqueM3u8Links.length
        };
    } catch (error) {
        console.error('Error with backup headers:', error);
        throw error;
    }
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: "M3U8 Scraper API", 
        version: "1.0.0",
        endpoints: {
            "/scrape": "Scrape m3u8 links from a URL",
            "/scrape/:slug": "Scrape m3u8 links using a video slug",
            "/packed/:slug": "Get raw packed JavaScript from a slug",
            "/unpack/:slug": "Get unpacked JavaScript from a slug"
        }
    });
});

app.get('/scrape', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                error: "URL parameter is required"
            });
        }
        
        const result = await getM3u8FromSource(url);
        res.json(result);
    } catch (error) {
        console.error(`Error in scrape endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`
        });
    }
});

app.get('/scrape/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        
        if (!slug) {
            return res.status(400).json({
                success: false,
                error: "Slug parameter is required"
            });
        }
        
        const url = `https://zpjid.com/bkg/${slug}?ref=animedub.pro`;
        const result = await getM3u8FromSource(url);
        res.json(result);
    } catch (error) {
        console.error(`Error in scrape_by_slug endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`
        });
    }
});

// NEW ENDPOINT: Get packed JavaScript by slug
app.get('/packed/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { index } = req.query;
        
        if (!slug) {
            return res.status(400).json({
                success: false,
                error: "Slug parameter is required"
            });
        }
        
        try {
            // Fetch HTML content
            const htmlContent = await fetchHtmlBySlug(slug);
            
            // Find eval-packed JavaScript
            const packedScripts = findEvalPackedJs(htmlContent);
            
            if (!packedScripts || packedScripts.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "No eval-packed scripts found for this slug"
                });
            }
            
            // If index is specified, return that specific script
            if (index !== undefined) {
                const scriptIndex = parseInt(index, 10);
                if (isNaN(scriptIndex) || scriptIndex < 0 || scriptIndex >= packedScripts.length) {
                    return res.status(400).json({
                        success: false,
                        error: `Invalid index: ${index}. Available range: 0-${packedScripts.length - 1}`
                    });
                }
                
                return res.json({
                    success: true,
                    slug,
                    script_index: scriptIndex,
                    total_scripts: packedScripts.length,
                    packed_js: packedScripts[scriptIndex]
                });
            }
            
            // Return all packed scripts if no index specified
            return res.json({
                success: true,
                slug,
                total_scripts: packedScripts.length,
                packed_scripts: packedScripts
            });
            
        } catch (error) {
            console.error(`Error fetching packed scripts: ${error.message}`);
            return res.status(500).json({
                success: false,
                error: `Error fetching packed scripts: ${error.message}`
            });
        }
    } catch (error) {
        console.error(`Error in packed endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`
        });
    }
});

// NEW ENDPOINT: Get unpacked JavaScript by slug
app.get('/unpack/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { index } = req.query;
        
        if (!slug) {
            return res.status(400).json({
                success: false,
                error: "Slug parameter is required"
            });
        }
        
        try {
            // Fetch HTML content
            const htmlContent = await fetchHtmlBySlug(slug);
            
            // Find eval-packed JavaScript
            const packedScripts = findEvalPackedJs(htmlContent);
            
            if (!packedScripts || packedScripts.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "No eval-packed scripts found for this slug"
                });
            }
            
            // If index is specified, unpack that specific script
            if (index !== undefined) {
                const scriptIndex = parseInt(index, 10);
                if (isNaN(scriptIndex) || scriptIndex < 0 || scriptIndex >= packedScripts.length) {
                    return res.status(400).json({
                        success: false,
                        error: `Invalid index: ${index}. Available range: 0-${packedScripts.length - 1}`
                    });
                }
                
                const unpackedJs = unpack(packedScripts[scriptIndex]);
                
                if (!unpackedJs) {
                    return res.status(500).json({
                        success: false,
                        error: `Failed to unpack script at index ${scriptIndex}`
                    });
                }
                
                // Extract m3u8 links from the unpacked script
                const m3u8Links = extractM3u8Links(unpackedJs);
                
                return res.json({
                    success: true,
                    slug,
                    script_index: scriptIndex,
                    total_scripts: packedScripts.length,
                    unpacked_js: unpackedJs,
                    m3u8_links: m3u8Links,
                    m3u8_count: m3u8Links.length
                });
            }
            
            // Unpack all scripts if no index specified
            const results = [];
            for (let i = 0; i < packedScripts.length; i++) {
                const unpackedJs = unpack(packedScripts[i]);
                if (unpackedJs) {
                    const m3u8Links = extractM3u8Links(unpackedJs);
                    results.push({
                        script_index: i,
                        unpacked_js: unpackedJs,
                        m3u8_links: m3u8Links,
                        m3u8_count: m3u8Links.length
                    });
                } else {
                    results.push({
                        script_index: i,
                        error: "Failed to unpack script"
                    });
                }
            }
            
            return res.json({
                success: true,
                slug,
                total_scripts: packedScripts.length,
                results
            });
            
        } catch (error) {
            console.error(`Error unpacking scripts: ${error.message}`);
            return res.status(500).json({
                success: false,
                error: `Error unpacking scripts: ${error.message}`
            });
        }
    } catch (error) {
        console.error(`Error in unpack endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`
        });
    }
});

// For testing unpacking directly
app.post('/unpack', express.text(), (req, res) => {
    try {
        const packedJs = req.body;
        if (!packedJs) {
            return res.status(400).json({
                success: false,
                error: "Request body is required with packed JavaScript"
            });
        }
        
        const unpacked = unpack(packedJs);
        if (!unpacked) {
            return res.status(400).json({
                success: false,
                error: "Failed to unpack the provided JavaScript"
            });
        }
        
        const m3u8Links = extractM3u8Links(unpacked);
        
        res.json({
            success: true,
            unpacked: unpacked,
            m3u8_links: m3u8Links,
            count: m3u8Links.length
        });
    } catch (error) {
        console.error(`Error in unpack endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`
        });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`M3U8 Extractor API running on port ${PORT}`);
});

module.exports = app; // Export for testing
