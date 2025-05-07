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
 * Extracts all JavaScript content from HTML, including packed scripts
 * @param {string} htmlContent - HTML content to search
 * @returns {object} - Object containing extracted scripts data
 */
function extractJavaScript(htmlContent) {
    // Extract all script tags first
    const scriptTagPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    const scriptContents = [];
    let match;
    
    // Collect all script contents
    while ((match = scriptTagPattern.exec(htmlContent)) !== null) {
        if (match[1] && match[1].trim().length > 0) {
            scriptContents.push(match[1]);
        }
    }
    
    // Process the raw HTML as well (in case scripts are not in script tags)
    const rawContent = htmlContent;
    
    // Find packed scripts using multiple detection techniques
    const packedScripts = [];
    
    // Patterns for different types of packed/obfuscated JS
    const packingPatterns = [
        // Standard eval packed pattern (packer)
        /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*(?:d|r)\s*\)\s*\{[\s\S]*?\}\s*\([\s\S]*?\)\s*\)/g,
        
        // Alternative packer patterns
        /\(function\s*\([\s\S]*?\)\s*\{[\s\S]*?\}\s*\([\s\S]*?\)\s*\)/g,
        
        // JJEncode pattern
        /var\s+\w+\s*=~\[\]\s*;\s*\w+\s*=\{\}[\s\S]*?"\)\(\)/g,
        
        // Common obfuscation pattern with hexadecimal strings
        /var\s+(_0x\w+|[a-zA-Z0-9_$]+)\s*=\s*\[(?:"|')[^\]]*(?:"|')\][^;]*;/g,
        
        // Function-based obfuscation
        /function\s+[a-zA-Z0-9_$]+\s*\([^)]*\)\s*\{\s*(?:var|let|const)\s+[^;]*=[^;]*;[\s\S]{100,}?return[^}]*\}/g
    ];
    
    // Search in each script content first
    for (const scriptContent of scriptContents) {
        for (const pattern of packingPatterns) {
            pattern.lastIndex = 0; // Reset regex state
            while ((match = pattern.exec(scriptContent)) !== null) {
                if (match[0] && match[0].length > 100) { // Only include substantial scripts
                    packedScripts.push({
                        source: 'script_tag',
                        content: match[0],
                        length: match[0].length
                    });
                }
            }
        }
    }
    
    // Search in raw HTML as well
    for (const pattern of packingPatterns) {
        pattern.lastIndex = 0; // Reset regex state
        while ((match = pattern.exec(rawContent)) !== null) {
            // Check if this match is already included from script tags
            const isDuplicate = packedScripts.some(script => 
                script.content === match[0] || 
                script.content.includes(match[0]) || 
                match[0].includes(script.content)
            );
            
            if (!isDuplicate && match[0] && match[0].length > 100) {
                packedScripts.push({
                    source: 'raw_html',
                    content: match[0],
                    length: match[0].length
                });
            }
        }
    }
    
    // Additional pass for large chunks that might be missed
    if (packedScripts.length === 0) {
        // Look for potential large JavaScript blocks
        const largeJsBlockPattern = /(var\s+\w+\s*=[\s\S]{100,}?;)|(function\s*\(\)[\s\S]{100,}?\})/g;
        
        for (const scriptContent of scriptContents) {
            largeJsBlockPattern.lastIndex = 0;
            while ((match = largeJsBlockPattern.exec(scriptContent)) !== null) {
                if (match[0] && match[0].length > 200) { // Only substantial blocks
                    packedScripts.push({
                        source: 'script_tag_large_block',
                        content: match[0],
                        length: match[0].length
                    });
                }
            }
        }
        
        largeJsBlockPattern.lastIndex = 0;
        while ((match = largeJsBlockPattern.exec(rawContent)) !== null) {
            if (match[0] && match[0].length > 200) { // Only substantial blocks
                const isDuplicate = packedScripts.some(script => 
                    script.content === match[0]
                );
                
                if (!isDuplicate) {
                    packedScripts.push({
                        source: 'raw_html_large_block',
                        content: match[0],
                        length: match[0].length
                    });
                }
            }
        }
    }
    
    return {
        scriptTagsCount: scriptContents.length,
        packedScripts: packedScripts,
        debug: {
            htmlLength: htmlContent.length,
            firstScriptSample: scriptContents.length > 0 ? 
                scriptContents[0].substring(0, 100) + '...' : 'No scripts found'
        }
    };
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
            timeout: 8000, // Increased timeout for complex scripts
            sandbox: {
                result: null,
                window: {
                    document: {},
                    navigator: { userAgent: 'Mozilla/5.0' },
                    location: { href: 'https://example.com' }
                },
                document: {
                    createElement: () => ({}),
                    getElementById: () => ({}),
                    body: {}
                },
                navigator: { userAgent: 'Mozilla/5.0' },
                location: { href: 'https://example.com' },
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
                setTimeout: function(fn) { try { fn(); } catch(e) {} },
                setInterval: function(fn) { try { fn(); } catch(e) {} },
                clearTimeout: function() {},
                clearInterval: function() {}
            }
        });

        // Enhanced unpacker handling different packing formats
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
                    window: {
                        document: {},
                        navigator: { userAgent: 'Mozilla/5.0' },
                        location: { href: 'https://example.com' }
                    },
                    document: {
                        createElement: function() { return {}; },
                        getElementById: function() { return {}; },
                        body: {}
                    },
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
                
                // Try multiple approaches if first one fails
                if(!result || (typeof result === 'string' && result.includes('Error'))) {
                    // Direct eval approach
                    try {
                        var evalResult;
                        var originalEval = eval;
                        env.eval = function(code) {
                            evalResult = code;
                        };
                        
                        with(env) {
                            originalEval(packed);
                        }
                        
                        if (evalResult) {
                            result = evalResult;
                        }
                    } catch(e) {
                        // Continue to next approach
                    }
                }
                
                // Function constructor approach
                if(!result || (typeof result === 'string' && result.includes('Error'))) {
                    try {
                        var fn = new Function('return ' + packed);
                        result = fn();
                        if (typeof result === 'function') {
                            result = result.toString();
                        }
                    } catch(e) {
                        // Continue to next approach
                    }
                }
                
                // Try a direct approach with function invocation
                if(!result || (typeof result === 'string' && result.includes('Error'))) {
                    try {
                        var directResult = eval(packed);
                        if (directResult && typeof directResult !== 'undefined') {
                            result = directResult;
                            if (typeof result === 'function') {
                                result = result.toString();
                            }
                        }
                    } catch(e) {
                        // Final fallback
                    }
                }
                
                return result;
            }
            result = unpack(${JSON.stringify(packedJs)});
        `;

        vm.run(unpacker);
        
        // Check if we got a valid result
        if (vm.sandbox.result && 
            typeof vm.sandbox.result === 'string' &&
            !vm.sandbox.result.includes('Error in')) {
            return vm.sandbox.result;
        }
        
        // Basic decoder for common obfuscation patterns
        if (packedJs.includes('eval(function(p,a,c,k,e,')) {
            // Try an additional approach specifically for Dean Edwards packer
            const deobfuscator = `
                var result = "";
                try {
                    // Mock eval to capture output
                    var originalEval = eval;
                    var capturedOutput = null;
                    
                    // Replace eval
                    eval = function(code) {
                        capturedOutput = code;
                        return code;
                    };
                    
                    // Execute the packed code
                    ${packedJs};
                    
                    // Restore eval
                    eval = originalEval;
                    
                    result = capturedOutput;
                } catch(e) {
                    result = "Deobfuscation error: " + e.message;
                }
            `;
            
            const deobfVm = new VM({
                timeout: 5000,
                sandbox: {
                    result: null,
                    console: { log: function(){}, error: function(){} }
                }
            });
            
            try {
                deobfVm.run(deobfuscator);
                if (deobfVm.sandbox.result && 
                    typeof deobfVm.sandbox.result === 'string' &&
                    !deobfVm.sandbox.result.includes('error')) {
                    return deobfVm.sandbox.result;
                }
            } catch (e) {
                console.error('Deobfuscator error:', e);
            }
        }
        
        // If all VM approaches fail, try regex-based unpacking for common formats
        const hexEscapePattern = /\\x([0-9a-fA-F]{2})/g;
        const unescaped = packedJs.replace(hexEscapePattern, (match, hex) => 
            String.fromCharCode(parseInt(hex, 16)));
            
        // If unescaping made a substantial change, return it
        if (unescaped !== packedJs && 
            (unescaped.includes('function(') || unescaped.includes('var '))) {
            return unescaped;
        }
        
        // If we can't unpack, return a processed version of the original
        return packedJs;
        
    } catch (error) {
        console.error('Error in unpacking:', error);
        return null;
    }
}

/**
 * API endpoint to get packed scripts
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
            
            // Extract JavaScript using our enhanced method
            const extracted = extractJavaScript(response.data);
            const packedScripts = extracted.packedScripts;
            
            console.log(`Found ${packedScripts.length} packed scripts`);
            
            if (!packedScripts || packedScripts.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "No packed scripts found for this slug",
                    debug: {
                        responseLength: response.data.length,
                        scriptTagsFound: extracted.scriptTagsCount,
                        sample: response.data.substring(0, 1000) + "..."
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
                    packed_js: packedScripts[scriptIndex].content,
                    script_length: packedScripts[scriptIndex].length,
                    source: packedScripts[scriptIndex].source
                });
            }
            
            // Return all packed scripts if no index specified
            return res.json({
                success: true,
                slug,
                total_scripts: packedScripts.length,
                packed_scripts: packedScripts.map((script, index) => ({
                    index,
                    content: script.content,
                    length: script.length,
                    source: script.source
                })),
                debug: {
                    first_script_sample: packedScripts[0].content.substring(0, 200) + "...",
                    last_script_sample: packedScripts[packedScripts.length - 1].content.substring(0, 200) + "...",
                    script_tags_found: extracted.scriptTagsCount
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
 * API endpoint to unpack individual packed script
 */
app.get('/unpack/:slug/:index?', async (req, res) => {
    try {
        const { slug, index } = req.params;
        
        if (!slug) {
            return res.status(400).json({
                success: false,
                error: "Slug parameter is required"
            });
        }
        
        try {
            // First get the packed script(s)
            let packedEndpoint = `http://localhost:${PORT}/packed/${slug}`;
            if (index !== undefined) {
                packedEndpoint += `?index=${index}`;
            }
            
            console.log(`Requesting packed script from: ${packedEndpoint}`);
            const packedResponse = await axios.get(packedEndpoint);
            
            if (!packedResponse.data.success) {
                return res.status(404).json({
                    success: false,
                    error: "Could not get packed scripts",
                    details: packedResponse.data
                });
            }
            
            // Handle case where specific index was requested
            if (index !== undefined) {
                const scriptContent = packedResponse.data.packed_js;
                
                if (!scriptContent) {
                    return res.status(400).json({
                        success: false,
                        error: `No script content found for index ${index}`
                    });
                }
                
                console.log(`Unpacking script of length ${scriptContent.length}`);
                
                const unpackedJs = unpackPackedScript(scriptContent);
                
                if (!unpackedJs) {
                    return res.status(500).json({
                        success: false,
                        error: `Failed to unpack script at index ${index}`
                    });
                }
                
                return res.json({
                    success: true,
                    slug,
                    script_index: parseInt(index, 10),
                    total_scripts: packedResponse.data.total_scripts,
                    unpacked_js: unpackedJs,
                    unpacked_length: unpackedJs.length,
                    source: packedResponse.data.source
                });
            }
            
            // Unpack all scripts
            const packedScripts = packedResponse.data.packed_scripts;
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
                
                console.log(`Unpacking script ${i+1}/${packedScripts.length} of length ${scriptContent.length}`);
                
                const unpackedJs = unpackPackedScript(scriptContent);
                
                if (unpackedJs) {
                    results.push({
                        script_index: i,
                        unpacked_js: unpackedJs,
                        unpacked_length: unpackedJs.length,
                        source: packedScripts[i].source,
                        status: "success"
                    });
                } else {
                    results.push({
                        script_index: i,
                        error: "Failed to unpack script",
                        source: packedScripts[i].source,
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
 * Alternative endpoint for direct script unpacking
 */
app.post('/unpack-raw', express.text({ limit: '10mb' }), async (req, res) => {
    try {
        const scriptContent = req.body;
        
        if (!scriptContent || scriptContent.length < 50) {
            return res.status(400).json({
                success: false,
                error: "Valid script content is required (min 50 characters)"
            });
        }
        
        console.log(`Unpacking raw script of length ${scriptContent.length}`);
        
        const unpackedJs = unpackPackedScript(scriptContent);
        
        if (!unpackedJs) {
            return res.status(500).json({
                success: false,
                error: "Failed to unpack script"
            });
        }
        
        return res.json({
            success: true,
            unpacked_js: unpackedJs,
            unpacked_length: unpackedJs.length
        });
        
    } catch (error) {
        console.error(`Error in unpack-raw endpoint: ${error}`);
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
    res.json({ status: 'ok', version: '1.2.0' });
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
    console.log(`JavaScript Extractor API running on port ${PORT}`);
    console.log(`Example endpoints:
    - Packed JS: http://localhost:${PORT}/packed/9q4yh8ji5k4w
    - Unpacked JS: http://localhost:${PORT}/unpack/9q4yh8ji5k4w
    - Specific script: http://localhost:${PORT}/unpack/9q4yh8ji5k4w/0
    - Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
