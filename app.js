const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { VM } = require('vm2');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

/**
 * Find eval-packed JavaScript in HTML content
 * @param {string} htmlContent - HTML content to search for packed scripts
 * @returns {string[]} - Array of packed scripts found
 */
function findEvalPackedJs(htmlContent) {
    // Extract script tags first to better isolate JavaScript content
    const scriptTagPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptContent = '';
    let match;
    
    // Collect all script content
    while ((match = scriptTagPattern.exec(htmlContent)) !== null) {
        scriptContent += match[1] + '\n';
    }
    
    // If no script tags found, use the entire HTML content
    if (!scriptContent) {
        scriptContent = htmlContent;
    }
    
    // More comprehensive patterns for eval-packed scripts
    const patterns = [
        // Standard eval packed pattern
        /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*(?:d|r)\s*\)\s*\{[\s\S]*?\}\s*\([\s\S]*?\)\s*\)/g,
        
        // Alternative packer patterns
        /\(function\s*\([\s\S]*?\)\s*\{[\s\S]*?\}\s*\([\s\S]*?\)\s*\)/g,
        
        // JJEncode pattern
        /var\s+\w+\s*=~\[\]\s*;\s*\w+\s*=\{\}[\s\S]*?"\)\(\)/g,
        
        // Common obfuscation pattern
        /var\s+_0x\w+\s*=\s*\["[^"]*"\][^;]*;/g
    ];
    
    // Collect all matches from different patterns
    const allMatches = [];
    for (const pattern of patterns) {
        const matches = [...scriptContent.matchAll(pattern)];
        for (const m of matches) {
            // Only add substantial scripts (avoid false positives)
            if (m[0].length > 100) {
                allMatches.push(m[0]);
            }
        }
    }
    
    // If standard methods fail, use a more aggressive approach to find large code blocks
    if (allMatches.length === 0) {
        // Look for potential large JavaScript blocks
        const largeJsBlockPattern = /(var\s+\w+\s*=[\s\S]{100,}?;)|(function\s*\(\)[\s\S]{100,}?\})/g;
        const largeMatches = [...scriptContent.matchAll(largeJsBlockPattern)];
        
        for (const m of largeMatches) {
            if (m[0] && m[0].length > 200) { // Only substantial blocks
                allMatches.push(m[0]);
            }
        }
    }
    
    return allMatches;
}

/**
 * Unpacks a packed JavaScript string
 * @param {string} packedJs - Packed JavaScript to unpack
 * @returns {string|null} - Unpacked JavaScript or null if unpacking fails
 */
function unpackPackedScript(packedJs) {
    try {
        // Create a sandbox with comprehensive environment
        const vm = new VM({
            timeout: 5000,
            sandbox: {
                result: null,
                window: {
                    document: {},
                    navigator: {},
                    location: {}
                },
                document: {},
                navigator: {},
                location: {},
                // Add common functions that might be referenced
                String: String,
                Array: Array,
                Object: Object,
                Math: Math,
                Date: Date,
                JSON: JSON,
                console: { 
                    log: function(){}, 
                    error: function(){} 
                },
                setTimeout: setTimeout,
                setInterval: setInterval,
                clearTimeout: clearTimeout,
                clearInterval: clearInterval
            }
        });

        // Robust unpacker that handles different packing formats
        const unpacker = `
            function unpack(packed) {
                var env = {
                    eval: function(c) { 
                        try {
                            result = c; 
                            if(typeof result === 'function') {
                                result = result.toString();
                            }
                        } catch(e) {
                            result = "Error in eval: " + e.message;
                        }
                    },
                    window: {},
                    document: {},
                    console: {
                        log: function() {},
                        error: function() {}
                    }
                };
                
                var result;
                try {
                    with(env) { 
                        eval(packed); 
                    }
                } catch(e) {
                    result = "Error in unpacking: " + e.message;
                }
                
                if(typeof result === 'string' && result.includes('Error')) {
                    // Try alternative unpacking method
                    try {
                        var fn = new Function('return ' + packed);
                        result = fn().toString();
                    } catch(e2) {
                        result = "Alternative unpacking failed: " + e2.message;
                    }
                }
                
                return result;
            }
            result = unpack(${JSON.stringify(packedJs)});
        `;

        vm.run(unpacker);
        return vm.sandbox.result;
    } catch (error) {
        console.error('Error in VM:', error);
        
        // Fallback to simple regex unpacking if VM fails
        try {
            // This handles common packed patterns
            const unpacked = packedJs.replace(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\(.*?\)\)/, '')
                                    .replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => 
                                        String.fromCharCode(parseInt(hex, 16)));
            return unpacked;
        } catch (fallbackError) {
            console.error('Fallback unpacking failed:', fallbackError);
            return null;
        }
    }
}

/**
 * API endpoint to get full packed scripts
 */
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
            // Fetch HTML content with proper error handling
            const url = `https://zpjid.com/bkg/${slug}?ref=animedub.pro`;
            console.log(`Fetching content from: ${url}`);
            
            const response = await axios.get(url, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Referer': 'https://animedub.pro/'
                }
            });
            
            console.log(`Response received, length: ${response.data.length}`);
            
            // Find eval-packed JavaScript with improved regex
            const packedScripts = findEvalPackedJs(response.data);
            console.log(`Found ${packedScripts.length} packed scripts`);
            
            if (!packedScripts || packedScripts.length === 0) {
                // Save a sample of the HTML for debugging
                const sampleHtml = response.data.substring(0, 2000) + "...";
                
                return res.status(404).json({
                    success: false,
                    error: "No eval-packed scripts found for this slug",
                    debug: {
                        responseLength: response.data.length,
                        sample: sampleHtml,
                        scripts_found: response.data.match(/<script/g) ? response.data.match(/<script/g).length : 0
                    }
                });
            }
            
            // If index is specified, return that specific script
            if (index !== undefined) {
                const scriptIndex = parseInt(index, 10);
                if (isNaN(scriptIndex)) {
                    return res.status(400).json({
                        success: false,
                        error: "Index must be a number"
                    });
                }
                
                if (scriptIndex < 0 || scriptIndex >= packedScripts.length) {
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
                    packed_js: packedScripts[scriptIndex],
                    script_length: packedScripts[scriptIndex].length
                });
            }
            
            // Return all packed scripts if no index specified
            return res.json({
                success: true,
                slug,
                total_scripts: packedScripts.length,
                packed_scripts: packedScripts.map(script => ({
                    content: script,
                    length: script.length
                })),
                debug: {
                    first_script_sample: packedScripts[0].substring(0, 200) + "...",
                    last_script_sample: packedScripts[packedScripts.length - 1].substring(0, 200) + "..."
                }
            });
            
        } catch (error) {
            console.error(`Error fetching packed scripts: ${error.message}`);
            return res.status(500).json({
                success: false,
                error: `Error fetching packed scripts: ${error.message}`,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    } catch (error) {
        console.error(`Error in packed endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * API endpoint to unpack packed scripts
 */
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
            // First get the packed scripts
            const packedResponse = await axios.get(`http://localhost:${PORT}/packed/${slug}${index !== undefined ? `?index=${index}` : ''}`);
            
            if (!packedResponse.data.success) {
                return res.status(404).json({
                    success: false,
                    error: "Could not get packed scripts",
                    details: packedResponse.data
                });
            }
            
            const packedScripts = packedResponse.data.packed_scripts || 
                                 [{ content: packedResponse.data.packed_js }];
            
            // If index is specified, unpack that specific script
            if (index !== undefined) {
                const scriptIndex = parseInt(index, 10);
                if (isNaN(scriptIndex)) {
                    return res.status(400).json({
                        success: false,
                        error: "Index must be a number"
                    });
                }
                
                const scriptContent = packedResponse.data.packed_js;
                
                if (!scriptContent) {
                    return res.status(400).json({
                        success: false,
                        error: `No script content found for index ${scriptIndex}`
                    });
                }
                
                const unpackedJs = unpackPackedScript(scriptContent);
                
                if (!unpackedJs) {
                    return res.status(500).json({
                        success: false,
                        error: `Failed to unpack script at index ${scriptIndex}`
                    });
                }
                
                return res.json({
                    success: true,
                    slug,
                    script_index: scriptIndex,
                    total_scripts: packedScripts.length,
                    unpacked_js: unpackedJs,
                    unpacked_length: unpackedJs.length
                });
            }
            
            // Unpack all scripts if no index specified
            const results = [];
            for (let i = 0; i < packedScripts.length; i++) {
                const scriptContent = packedScripts[i].content;
                
                if (!scriptContent) {
                    results.push({
                        script_index: i,
                        error: "No script content found",
                        status: "failed"
                    });
                    continue;
                }
                
                const unpackedJs = unpackPackedScript(scriptContent);
                
                if (unpackedJs) {
                    results.push({
                        script_index: i,
                        unpacked_js: unpackedJs,
                        unpacked_length: unpackedJs.length,
                        status: "success"
                    });
                } else {
                    results.push({
                        script_index: i,
                        error: "Failed to unpack script",
                        status: "failed"
                    });
                }
            }
            
            return res.json({
                success: true,
                slug,
                total_scripts: packedScripts.length,
                results,
                stats: {
                    success_count: results.filter(r => r.status === "success").length,
                    failed_count: results.filter(r => r.status === "failed").length
                }
            });
            
        } catch (error) {
            console.error(`Error unpacking scripts: ${error.message}`);
            return res.status(500).json({
                success: false,
                error: `Error unpacking scripts: ${error.message}`,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    } catch (error) {
        console.error(`Error in unpack endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * Simple health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.1.0' });
});

/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`M3U8 Extractor API running on port ${PORT}`);
    console.log(`Try these endpoints:
    - http://localhost:${PORT}/packed/9q4yh8ji5k4w
    - http://localhost:${PORT}/unpack/9q4yh8ji5k4w`);
});

module.exports = app;
